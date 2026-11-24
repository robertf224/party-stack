import { it } from "@effect/vitest";
import { BackendError, makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset, objectSubset } from "@party-stack/ontology-backend/subset";
import { o, type OntologyIR, type QueryDocument } from "@party-stack/ontology-spec";
import * as q from "@party-stack/ontology-spec/query";
import { eq, evaluateQuery, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Scope } from "effect";
import { TestClock } from "effect/testing";
import { makeReplica } from "./service.js";
import type { OwnedTransaction } from "@party-stack/ontology-backend/owned";
import type { ObjectSubset } from "@party-stack/ontology-spec/query";

// Oracle: the source's own state and the definition each side runs. The source changes
// its definition (a property changes type, a property or object type comes or goes, or
// only display text changes) while edits, actions, reads, downloads and held dispatches
// continue; the app restarts sometimes under its old definition and sometimes adopting
// the source's, with `onDefinitionChange: "reset"`. Then:
//   - opening never fails and nothing dies;
//   - every row a read serves fits the definition the replica runs, never an older one;
//   - while both sides agree, reads of types they both have succeed;
//   - every queued action is applied at the source exactly once, none is lost;
//   - once both sides agree and everything settles, reads converge to the source and each
//     download is ready exactly when its query fits the final definition.

type Shape = {
    readonly label: "string" | "integer";
    readonly note: boolean;
    readonly tag: boolean;
    readonly title: "A" | "B";
};
const initial: Shape = { label: "integer", note: false, tag: true, title: "A" };
const definition = (shape: Shape): OntologyIR => ({
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Item",
            displayName: `Item ${shape.title}`,
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "value", displayName: "Value", type: o.integer({}) },
                {
                    name: "label",
                    displayName: "Label",
                    type: shape.label === "string" ? o.string({}) : o.integer({}),
                },
                ...(shape.note
                    ? [{ name: "note", displayName: "Note", type: o.optional({ type: o.string({}) }) }]
                    : []),
            ],
        },
        ...(shape.tag
            ? [
                  {
                      name: "Tag",
                      displayName: "Tag",
                      pluralDisplayName: "Tags",
                      primaryKey: "id",
                      properties: [
                          { name: "id", displayName: "ID", type: o.string({}) },
                          { name: "name", displayName: "Name", type: o.string({}) },
                      ],
                  },
              ]
            : []),
    ],
    actionTypes: [
        {
            name: "increment",
            displayName: "Increment",
            parameters: [{ name: "id", displayName: "ID", type: o.string({}) }],
            logic: [],
        },
    ],
});
const same = (left: Shape, right: Shape) => JSON.stringify(left) === JSON.stringify(right);

const ids = ["i0", "i1", "i2"] as const;
const subsets: Record<string, ObjectSubset> = {
    items: objectSubset("Item"),
    point: objectSubset("Item", { where: eq(field("id"), "i0") }),
    tags: objectSubset("Tag"),
};
const objectTypes: Record<string, "Item" | "Tag"> = { items: "Item", point: "Item", tags: "Tag" };
// Downloads set while the initial definition has both types.
const downloads: Record<string, QueryDocument> = {
    items: {
        select: [
            q.sub("items", {
                from: { source: { objectType: "Item" }, binding: "i" },
                select: [
                    q.selectField("id", q.field("i", "id")),
                    q.selectField("value", q.field("i", "value")),
                ],
            }),
        ],
    },
    tags: {
        select: [
            q.sub("tags", {
                from: { source: { objectType: "Tag" }, binding: "t" },
                select: [q.selectField("id", q.field("t", "id"))],
            }),
        ],
    },
};

const Id = Schema.Literals(ids);
const Operation = Schema.Union([
    Schema.Struct({
        kind: Schema.Literal("edit"),
        id: Id,
        value: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9 })),
        label: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9 })),
        note: Schema.Boolean,
    }),
    Schema.Struct({ kind: Schema.Literal("increment"), id: Id }),
    Schema.Struct({ kind: Schema.Literal("read"), subset: Schema.Literals(["items", "point", "tags"]) }),
    // A checkpoint: load what is due, then dispatch the outbox.
    Schema.Struct({ kind: Schema.Literal("pass") }),
    // Later dispatches commit at the source, then wait for `release` before returning.
    Schema.Struct({ kind: Schema.Literal("hold") }),
    Schema.Struct({ kind: Schema.Literal("release") }),
    // The source moves to a new definition. The replica keeps its own until it reopens.
    Schema.Struct({
        kind: Schema.Literal("change"),
        to: Schema.Literals([
            "labelString",
            "labelInteger",
            "addNote",
            "removeNote",
            "addTag",
            "removeTag",
            "retitle",
        ]),
    }),
    // The app restarts on the same storage, under its old definition or the source's.
    Schema.Struct({ kind: Schema.Literal("reopen"), adopt: Schema.Boolean }),
]);
const Scenario = Schema.Struct({
    downloads: Schema.Boolean,
    operations: Schema.Array(Operation).check(Schema.isMinLength(6), Schema.isMaxLength(24)),
});

const run = (scenario: typeof Scenario.Type) =>
    Effect.scoped(
        Effect.gen(function* () {
            let violation: string | undefined;
            const fail = (message: string) => {
                violation ??= message;
            };

            // The source: canonical rows, projected through whichever definition it runs.
            let sourceShape = initial;
            const items = new Map<string, { value: number; label: number; note?: string }>([
                ["i0", { value: 0, label: 0 }],
                ["i1", { value: 0, label: 1, note: "seed" }],
            ]);
            const tags = [{ id: "t0", name: "zero" }];
            const project = (shape: Shape, id: string) => {
                const row = items.get(id)!;
                return {
                    id,
                    value: row.value,
                    label: shape.label === "string" ? String(row.label) : row.label,
                    ...(shape.note && row.note !== undefined ? { note: row.note } : {}),
                };
            };
            const applied = new Map<string, number>();
            let hold: Deferred.Deferred<void> | undefined;
            // One backend per replica definition, all serving the same source under one id.
            const backendFor = (shape: Shape) =>
                makeOntologyBackend({
                    ir: definition(shape),
                    name: "definition-oracle",
                    sourceId: "definition-oracle",
                    supportsIdempotency: true,
                    queryFunction: () => Effect.void,
                    loadSubset: (request) =>
                        Effect.gen(function* () {
                            // The source answers with its own definition, whatever the replica runs.
                            const subset = yield* compileObjectSubset(definition(sourceShape), request);
                            const rows: { key: string; value: Record<string, unknown> }[] =
                                subset.objectType === "Tag"
                                    ? tags.map((tag) => ({ key: tag.id, value: { ...tag } }))
                                    : [...items.keys()].map((id) => ({
                                          key: id,
                                          value: project(sourceShape, id),
                                      }));
                            return { complete: true, rows: evaluateQuery(rows, subset.query ?? {}) };
                        }),
                    applyAction: (request) =>
                        Effect.gen(function* () {
                            const id = String(request.parameters.id);
                            // A deduplicating source applies each action id once.
                            if (!applied.has(request.id)) {
                                applied.set(request.id, 1);
                                const row = items.get(id);
                                if (row) items.set(id, { ...row, value: row.value + 1 });
                            } else applied.set(request.id, applied.get(request.id)! + 1);
                            if (hold) yield* Deferred.await(hold);
                            return {
                                operationId: request.id,
                                outcome: "committed" as const,
                                affected: [{ objectType: "Item", keys: [id] }],
                            };
                        }),
                });

            const increment = Effect.fnUntraced(function* (
                tx: OwnedTransaction,
                request: { parameters: Record<string, unknown> }
            ) {
                const row = yield* tx.get("Item", String(request.parameters.id));
                if (row) yield* tx.put("Item", { ...row, value: Number(row.value) + 1 });
            });
            const tables = yield* Memory.make();
            let replicaShape = initial;
            const open = Effect.gen(function* () {
                const scope = yield* Scope.make();
                const exit = yield* Effect.exit(
                    makeReplica({
                        namespace: "definition-oracle",
                        ir: definition(replicaShape),
                        tables,
                        backend: backendFor(replicaShape),
                        onDefinitionChange: "reset",
                        mutators: { increment },
                    }).pipe(Scope.provide(scope))
                );
                if (Exit.isFailure(exit)) {
                    fail(`open failed: ${Cause.pretty(exit.cause).split("\n")[0]}`);
                    return undefined;
                }
                return { replica: exit.value, scope };
            });
            let opened = yield* open;
            if (!opened) return yield* Effect.fail(new Error(violation));

            const settle = <A, E>(label: string, effect: Effect.Effect<A, E>) =>
                Effect.gen(function* () {
                    const fiber = yield* Effect.forkScoped(Effect.exit(effect));
                    for (let waited = 0; waited < 60_000 && !fiber.pollUnsafe(); waited += 1_000) {
                        for (let step = 0; step < 20; step++) yield* Effect.yieldNow;
                        if (!fiber.pollUnsafe()) yield* TestClock.adjust(1_000);
                    }
                    if (!fiber.pollUnsafe()) {
                        yield* Fiber.interrupt(fiber);
                        fail(`${label} never finished`);
                        return undefined;
                    }
                    const exit = yield* Fiber.join(fiber);
                    if (Exit.hasDies(exit)) fail(`${label} died: ${Cause.pretty(exit.cause).split("\n")[0]}`);
                    return exit;
                });
            const progress = Effect.gen(function* () {
                for (let step = 0; step < 40; step++) {
                    yield* TestClock.adjust(0);
                    yield* Effect.yieldNow;
                }
            });

            // Every row served must fit the definition the replica runs.
            const fits = (shape: Shape, objectType: string, row: Record<string, unknown>) => {
                if (objectType === "Tag") return shape.tag && typeof row.name === "string";
                if (typeof row.value !== "number") return false;
                if (typeof row.label !== (shape.label === "string" ? "string" : "number")) return false;
                return shape.note || !("note" in row);
            };
            // Changes and restarts each start a new epoch; a read that spans one is not judged.
            let epoch = 0;
            const reads: Array<Fiber.Fiber<void>> = [];
            const read = (name: string) =>
                Effect.gen(function* () {
                    const replica = opened!.replica;
                    const shape = replicaShape;
                    const subset = subsets[name]!;
                    const started = epoch;
                    const agree = same(replicaShape, sourceShape);
                    const both = objectTypes[name] !== "Tag" || (replicaShape.tag && sourceShape.tag);
                    reads.push(
                        yield* Effect.forkScoped(
                            Effect.gen(function* () {
                                const exit = yield* Effect.exit(
                                    Effect.scoped(
                                        Effect.andThen(
                                            replica.demand.acquire(subset),
                                            replica.readSubset(subset)
                                        )
                                    )
                                );
                                if (exit._tag === "Failure") {
                                    const cause = exit.cause;
                                    if (Cause.hasDies(cause))
                                        return fail(
                                            `read ${name} died: ${Cause.pretty(cause).split("\n")[0]}`
                                        );
                                    // Reads may fail while the sides disagree, or for a type one lacks.
                                    if (agree && both && epoch === started && !Cause.hasInterruptsOnly(cause))
                                        fail(
                                            `read ${name} failed while both sides agree: ${Cause.pretty(cause).split("\n")[0]}`
                                        );
                                    return;
                                }
                                for (const row of exit.value)
                                    if (!fits(shape, objectTypes[name]!, row.value))
                                        fail(
                                            `read ${name} served ${JSON.stringify(row.value)} under ${JSON.stringify(shape)}`
                                        );
                            })
                        )
                    );
                });

            const passes: Array<Fiber.Fiber<void, BackendError>> = [];
            const enqueued: string[] = [];
            let sequence = 0;
            if (scenario.downloads) {
                for (const [name, query] of Object.entries(downloads))
                    yield* opened.replica.demand.pins.set({ name, query });
            }
            const reopen = (adopt: boolean) =>
                Effect.gen(function* () {
                    for (const fiber of [...passes, ...reads]) yield* Fiber.interrupt(fiber);
                    passes.length = 0;
                    reads.length = 0;
                    epoch++;
                    if (hold) {
                        yield* Deferred.succeed(hold, undefined);
                        hold = undefined;
                    }
                    yield* Scope.close(opened!.scope, Exit.void);
                    if (adopt) replicaShape = sourceShape;
                    opened = yield* open;
                });

            for (const operation of scenario.operations) {
                if (!opened) break;
                const replica = opened.replica;
                if (operation.kind === "edit") {
                    items.set(operation.id, {
                        value: operation.value,
                        label: operation.label,
                        ...(operation.note ? { note: `n${operation.label}` } : {}),
                    });
                } else if (operation.kind === "increment") {
                    const id = `increment-${sequence++}`;
                    const exit = yield* Effect.exit(
                        replica.outbox.enqueue({ id, name: "increment", parameters: { id: operation.id } })
                    );
                    if (exit._tag === "Success") enqueued.push(id);
                    else fail(`enqueue failed: ${Cause.pretty(exit.cause).split("\n")[0]}`);
                } else if (operation.kind === "read") yield* read(operation.subset);
                else if (operation.kind === "pass") passes.push(yield* Effect.forkScoped(replica.syncOnce));
                else if (operation.kind === "hold") hold ??= yield* Deferred.make<void>();
                else if (operation.kind === "release") {
                    if (hold) yield* Deferred.succeed(hold, undefined);
                    hold = undefined;
                } else if (operation.kind === "change") {
                    epoch++;
                    const to = operation.to;
                    sourceShape = {
                        ...sourceShape,
                        ...(to === "labelString" ? { label: "string" as const } : {}),
                        ...(to === "labelInteger" ? { label: "integer" as const } : {}),
                        ...(to === "addNote" ? { note: true } : {}),
                        ...(to === "removeNote" ? { note: false } : {}),
                        ...(to === "addTag" ? { tag: true } : {}),
                        ...(to === "removeTag" ? { tag: false } : {}),
                        ...(to === "retitle"
                            ? { title: sourceShape.title === "A" ? ("B" as const) : ("A" as const) }
                            : {}),
                    };
                } else yield* reopen(operation.adopt);
                yield* progress;
                if (violation) return yield* Effect.fail(new Error(violation));
            }
            if (!opened) return yield* Effect.fail(new Error(violation));

            // Settle: release dispatches, let passes finish, then the app adopts the source's
            // definition and catches up.
            if (hold) yield* Deferred.succeed(hold, undefined);
            hold = undefined;
            for (const fiber of [...passes, ...reads]) yield* settle("a read or pass", Fiber.join(fiber));
            yield* reopen(true);
            if (!opened) return yield* Effect.fail(new Error(violation));
            const replica = opened.replica;
            for (let pass = 0; pass < 3; pass++) {
                const exit = yield* settle("a checkpoint", replica.syncOnce);
                if (exit && Exit.isFailure(exit) && pass === 2)
                    fail(`checkpoint failed: ${Cause.pretty(exit.cause).split("\n")[0]}`);
            }
            if (violation) return yield* Effect.fail(new Error(violation));

            // Exactly once: every queued action reached the source once and left the outbox.
            const left = yield* replica.outbox.entries;
            if (left.length)
                fail(
                    `${left.length} action(s) still queued: ${left.map((entry) => `${entry.invocation.id}:${entry.state}`).join(", ")}`
                );
            for (const id of enqueued) if (applied.get(id) === undefined) fail(`${id} was never applied`);

            // Convergence under the shared definition.
            const exit = yield* settle(
                "a converging read",
                // Nothing tells the replica about source edits here, so reload what it has.
                Effect.scoped(
                    Effect.gen(function* () {
                        yield* replica.demand.acquire(subsets.items!);
                        yield* replica.revalidate;
                        return yield* replica.readSubset(subsets.items!);
                    })
                )
            );
            if (exit && Exit.isSuccess(exit)) {
                const rows = [...exit.value]
                    .map((row) => row.value)
                    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
                const expected = [...items.keys()].sort().map((id) => project(sourceShape, id));
                if (JSON.stringify(rows) !== JSON.stringify(expected))
                    fail(`did not converge: ${JSON.stringify(rows)} != ${JSON.stringify(expected)}`);
            } else if (exit) fail(`converging read failed: ${Cause.pretty(exit.cause).split("\n")[0]}`);

            // Each download is ready exactly when its query fits the final definition.
            if (scenario.downloads) {
                const pins = yield* replica.demand.pins.list;
                for (const pin of pins) {
                    const fitsFinal = pin.name === "items" || sourceShape.tag;
                    if (fitsFinal && !pin.ready)
                        fail(`download ${pin.name} not ready: ${JSON.stringify(pin.error)}`);
                    if (!fitsFinal && (pin.ready || pin.error?.kind !== "InvalidRequest"))
                        fail(`download ${pin.name} should report an invalid query: ${JSON.stringify(pin)}`);
                }
            }
            if (violation) return yield* Effect.fail(new Error(violation));
            return true;
        })
    );

it.effect.prop(
    "definition changes reset the cache without failing to open, serving old-shape rows or losing actions",
    [Scenario],
    ([scenario]) => run(scenario as typeof Scenario.Type),
    { arbitrary: { runs: 200, size: 24, seed: "definition-change-v1" }, timeout: 120_000 }
);
