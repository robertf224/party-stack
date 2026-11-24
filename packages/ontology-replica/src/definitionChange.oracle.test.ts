import { it } from "@effect/vitest";
import { BackendError, makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset, objectSubset } from "@party-stack/ontology-backend/subset";
import { o, type OntologyIR, type QueryDocument } from "@party-stack/ontology-spec";
import * as q from "@party-stack/ontology-spec/query";
import { eq, evaluateQuery, field } from "@party-stack/ontology-storage";
import { Table } from "@party-stack/ontology-storage/tables";
import { MemoryRuntime, Runtimes } from "@party-stack/runtime";
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Scope } from "effect";
import { TestClock } from "effect/testing";
import { makeReplicaPartitionCatalog } from "./registry.js";
import type { OntologyDescription } from "@party-stack/ontology-backend/description";
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

const Change = Schema.Literals([
    "labelString",
    "labelInteger",
    "addNote",
    "removeNote",
    "addTag",
    "removeTag",
    "retitle",
]);
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
        to: Change,
    }),
    // The app restarts on the same storage, under its old definition or the source's.
    Schema.Struct({ kind: Schema.Literal("reopen"), adopt: Schema.Boolean }),
    // A server-managed rebuild to the source's definition, as after an upstream schema
    // mismatch: the catalog retires the open replica, resets it and records the new
    // definition, and the next open uses it.
    Schema.Struct({ kind: Schema.Literal("rebuild") }),
]);
const Scenario = Schema.Struct({
    downloads: Schema.Boolean,
    // "open": replicas reset themselves when opened under a new definition. "rebuild": they
    // open with `"error"`, so only a catalog rebuild moves them to a new definition (an
    // adopting restart rebuilds first).
    resetBy: Schema.Literals(["open", "rebuild"]),
    operations: Schema.Array(Operation).check(Schema.isMinLength(6), Schema.isMaxLength(24)),
    // Progress under continuous change: after the operations, the source changes its
    // definition every `periodMs`; each time the replica adopts it, by restart or rebuild,
    // and an action and two reads issued right after must finish before the next change.
    churn: Schema.optional(
        Schema.Struct({
            periodMs: Schema.Literals([2_000, 4_000]),
            via: Schema.Literals(["reopen", "rebuild", "mixed"]),
            changes: Schema.Array(Change).check(Schema.isMinLength(2), Schema.isMaxLength(6)),
        })
    ),
});
const ChurnScenario = Schema.Struct({
    ...Scenario.fields,
    churn: Schema.Struct({
        periodMs: Schema.Literals([2_000, 4_000]),
        via: Schema.Literals(["reopen", "rebuild", "mixed"]),
        changes: Schema.Array(Change).check(Schema.isMinLength(2), Schema.isMaxLength(6)),
    }),
});
const changed = (shape: Shape, to: typeof Change.Type): Shape => ({
    ...shape,
    ...(to === "labelString" ? { label: "string" as const } : {}),
    ...(to === "labelInteger" ? { label: "integer" as const } : {}),
    ...(to === "addNote" ? { note: true } : {}),
    ...(to === "removeNote" ? { note: false } : {}),
    ...(to === "addTag" ? { tag: true } : {}),
    ...(to === "removeTag" ? { tag: false } : {}),
    ...(to === "retitle" ? { title: shape.title === "A" ? ("B" as const) : ("A" as const) } : {}),
});
const description = (shape: Shape): OntologyDescription => ({
    version: 1,
    replication: "committed",
    sourceId: "definition-oracle",
    ir: definition(shape),
    context: {},
    supportsIdempotency: true,
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
            // Hold the partition's storage for the whole run, as a device keeps its database
            // across restarts; a memory runtime nobody holds is discarded.
            const storage = yield* (yield* Runtimes).acquire({
                owner: "anonymous",
                namespace: "definition-oracle",
            });
            const catalog = yield* makeReplicaPartitionCatalog();
            let replicaShape = initial;
            const open = Effect.gen(function* () {
                const scope = yield* Scope.make();
                const exit = yield* Effect.exit(
                    catalog
                        .open("definition-oracle", {
                            ir: definition(replicaShape),
                            backend: backendFor(replicaShape),
                            bootstrap: description(replicaShape),
                            onDefinitionChange: scenario.resetBy === "open" ? "reset" : "error",
                            mutators: { increment },
                        })
                        .pipe(Scope.provide(scope))
                );
                if (Exit.isFailure(exit)) {
                    fail(`open failed: ${Cause.pretty(exit.cause).split("\n")[0]}`);
                    return undefined;
                }
                return { replica: exit.value.replica, scope };
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
            // A non-retryable load failure stays on its demand until it is revalidated or the
            // replica restarts; later reads of that subset get the same failure without a fetch.
            const terminal = new Map<string, string>();
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
                                    const error = Cause.squash(cause);
                                    const message =
                                        error instanceof BackendError ? error.message : String(error);
                                    const replayed = terminal.get(name) === message;
                                    if (error instanceof BackendError && !error.retryable)
                                        terminal.set(name, message);
                                    // Reads may fail while the sides disagree, or for a type one lacks.
                                    if (
                                        agree &&
                                        both &&
                                        epoch === started &&
                                        !replayed &&
                                        !Cause.hasInterruptsOnly(cause)
                                    )
                                        fail(
                                            `read ${name} failed while both sides agree: ${Cause.pretty(cause).split("\n")[0]}`
                                        );
                                    return;
                                }
                                // The seed rows always exist at the source, so a read made while both
                                // sides agree must include them.
                                const seeds =
                                    name === "items" ? ["i0", "i1"] : name === "point" ? ["i0"] : ["t0"];
                                const served = new Set(exit.value.map((row) => String(row.key)));
                                if (agree && both && epoch === started)
                                    for (const seed of seeds)
                                        if (!served.has(seed)) fail(`read ${name} is missing ${seed}`);
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
            // Keys of a type's confirmed cached rows, straight from storage.
            const cachedKeys = (type: string) =>
                storage.tables
                    .query(
                        Table.make({ name: JSON.stringify(["replica", "definition-oracle", `base:${type}`]) })
                    )
                    .pipe(
                        Effect.map((rows) => JSON.stringify(rows.map((row) => String(row.key)).sort())),
                        Effect.orDie
                    );
            const restart = (how: "reopen" | "adopt" | "rebuild") =>
                Effect.gen(function* () {
                    for (const fiber of [...passes, ...reads]) yield* Fiber.interrupt(fiber);
                    passes.length = 0;
                    reads.length = 0;
                    terminal.clear();
                    epoch++;
                    if (hold) {
                        yield* Deferred.succeed(hold, undefined);
                        hold = undefined;
                    }
                    if (how === "rebuild") {
                        const rebuilt = yield* Effect.exit(
                            catalog.rebuild("definition-oracle", description(sourceShape))
                        );
                        if (rebuilt._tag === "Failure")
                            fail(`rebuild failed: ${Cause.pretty(rebuilt.cause).split("\n")[0]}`);
                    }
                    yield* Scope.close(opened!.scope, Exit.void);
                    const previous = replicaShape;
                    const cachedBefore = { Item: yield* cachedKeys("Item"), Tag: yield* cachedKeys("Tag") };
                    if (how !== "reopen") replicaShape = sourceShape;
                    opened = yield* open;
                    // A reset when opening clears only types whose own definition changed: every
                    // other type keeps exactly the rows it had cached. (A rebuild resets everything.)
                    if (opened && how === "adopt" && scenario.resetBy === "open") {
                        const kept = {
                            Item:
                                previous.label === replicaShape.label && previous.note === replicaShape.note,
                            Tag: previous.tag && replicaShape.tag,
                        };
                        for (const type of ["Item", "Tag"] as const)
                            if (kept[type] && (yield* cachedKeys(type)) !== cachedBefore[type])
                                fail(`${type} rows changed across a reset that did not change ${type}`);
                    }
                });
            const reopen = (adopt: boolean) =>
                restart(adopt ? (scenario.resetBy === "open" ? "adopt" : "rebuild") : "reopen");

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
                    sourceShape = changed(sourceShape, operation.to);
                } else if (operation.kind === "rebuild") yield* restart("rebuild");
                else yield* reopen(operation.adopt);
                yield* progress;
                if (violation) return yield* Effect.fail(new Error(violation));
            }
            if (!opened) return yield* Effect.fail(new Error(violation));

            // Settle: release dispatches, let passes finish, then the app adopts the source's
            // definition and catches up.
            if (hold) yield* Deferred.succeed(hold, undefined);
            hold = undefined;
            for (const fiber of [...passes, ...reads]) yield* settle("a read or pass", Fiber.join(fiber));
            passes.length = 0;
            reads.length = 0;

            // Progress while the definition keeps changing.
            if (scenario.churn) {
                const { periodMs, via, changes } = scenario.churn;
                for (const [index, to] of changes.entries()) {
                    sourceShape = changed(sourceShape, to);
                    const how =
                        scenario.resetBy === "rebuild" || via === "rebuild" || (via === "mixed" && index % 2)
                            ? "rebuild"
                            : "adopt";
                    yield* restart(how);
                    if (!opened) return yield* Effect.fail(new Error(violation));
                    const id = `increment-${sequence++}`;
                    const queued = yield* Effect.exit(
                        opened.replica.outbox.enqueue({ id, name: "increment", parameters: { id: "i0" } })
                    );
                    if (queued._tag === "Success") enqueued.push(id);
                    else fail(`enqueue failed: ${Cause.pretty(queued.cause).split("\n")[0]}`);
                    yield* read("items");
                    yield* read("point");
                    for (let waited = 0; waited < periodMs; waited += 250) {
                        yield* progress;
                        yield* TestClock.adjust(250);
                    }
                    yield* progress;
                    const stuck = reads.filter((fiber) => fiber.pollUnsafe() === undefined).length;
                    if (stuck) fail(`${stuck} read(s) unfinished ${periodMs} ms after change ${index}`);
                    if (!applied.has(id)) fail(`${id} not applied ${periodMs} ms after change ${index}`);
                    if (violation) return yield* Effect.fail(new Error(violation));
                }
            }
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
            for (const id of enqueued)
                if (applied.get(id) === undefined) {
                    const status = yield* Effect.result(replica.outbox.get(id));
                    fail(
                        `${id} was never applied: ${JSON.stringify(status._tag === "Success" ? status.success : status.failure.message)}`
                    );
                }

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
    ).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)));

it.effect.prop(
    "definition changes reset the cache without failing to open, serving old-shape rows or losing actions",
    [Scenario],
    ([scenario]) => run(scenario as typeof Scenario.Type),
    { arbitrary: { runs: 200, size: 24, seed: "definition-change-v1" }, timeout: 120_000 }
);
it.effect.prop(
    "reads and actions keep completing while the definition keeps changing",
    [ChurnScenario],
    ([scenario]) => run(scenario as typeof Scenario.Type),
    { arbitrary: { runs: 100, size: 24, seed: "definition-churn-v1" }, timeout: 120_000 }
);
