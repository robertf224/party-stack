import { it } from "@effect/vitest";
import { BackendError, makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { eq, evaluateQuery, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Clock, Deferred, Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { makeReplica } from "./testing.js";
import type { CompiledSubset } from "@party-stack/ontology-backend/subset";

// Oracle: the source's own history. Under any interleaving of source edits, clock
// jumps, poll ticks, held loads, held action dispatches and reads, a read that
// resolves must return, row by row, the source state at some instant inside its
// freshness bound: `maxCoverageAgeMs` for a fresh proof, `maxStaleAgeMs` for a stale
// one. A row's confirmed version never moves backwards, and once everything is
// released the replica converges to the source.

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "value", displayName: "Value", type: o.integer({}) },
                { name: "group", displayName: "Group", type: o.string({}) },
                { name: "version", displayName: "Version", type: o.integer({}) },
            ],
        },
    ],
    actionTypes: [
        {
            name: "increment",
            displayName: "Increment",
            parameters: [{ name: "id", displayName: "ID", type: o.string({}) }],
            logic: [],
        },
    ],
};
type Item = { id: string; value: number; group: string; version: number };
const ids = ["i0", "i1", "i2"] as const;
const subsets: Record<string, CompiledSubset> = {
    whole: { objectType: "Item" },
    groupA: { objectType: "Item", query: { where: eq(field("group"), "a") } },
    point: { objectType: "Item", query: { where: eq(field("id"), "i0") } },
};
const maxCoverageAgeMs = 1_000;
const maxStaleAgeMs = 5_000;
const pollIntervalMs = 2_000;

const Id = Schema.Literals(ids);
const ops = {
    edit: Schema.Struct({
        kind: Schema.Literal("edit"),
        id: Id,
        value: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9 })),
        group: Schema.Literals(["a", "b"]),
    }),
    advance: Schema.Struct({
        kind: Schema.Literal("advance"),
        ms: Schema.Literals([0, 1_200, 3_000, 8_000]),
    }),
    read: Schema.Struct({
        kind: Schema.Literal("read"),
        subset: Schema.Literals(["whole", "groupA", "point"]),
    }),
    // Later loads or action dispatches block until `release`.
    hold: Schema.Struct({ kind: Schema.Literal("hold"), what: Schema.Literals(["loads", "actions"]) }),
    // Held loads resume one at a time: in start order, or newest first.
    release: Schema.Struct({ kind: Schema.Literal("release"), order: Schema.Literals(["oldest", "newest"]) }),
    // An explicit checkpoint: load what is due, then dispatch the outbox.
    pass: Schema.Struct({ kind: Schema.Literal("pass") }),
    revalidate: Schema.Struct({ kind: Schema.Literal("revalidate") }),
    increment: Schema.Struct({ kind: Schema.Literal("increment"), id: Id }),
    // The next receipt's read-back fails, leaving its commit unconfirmed until a later pass.
    lostReadBack: Schema.Struct({ kind: Schema.Literal("lostReadBack") }),
};
const Operation = Schema.Union(Object.values(ops));
const scenario = <Op extends Schema.Top>(operation: Op, settings: Schema.Struct.Fields) =>
    Schema.Struct({
        ...settings,
        operations: Schema.Array(operation).check(Schema.isMinLength(6), Schema.isMaxLength(24)),
    });
const Scenario = Schema.Struct({
    stale: Schema.Boolean,
    poll: Schema.Boolean,
    // The reference: every load and install under the sync gate.
    serial: Schema.Boolean,
    // The background sync loop and outbox worker run alongside explicit passes.
    background: Schema.Boolean,
    // "start": a held fetch returns the source as it was when it began, like a slow
    // response, so overlapping loads finish out of order. Freshness is then judged by
    // install time, which a slow response legitimately exceeds; those runs check
    // version order and convergence.
    capture: Schema.Literals(["end", "start"]),
    // Every fetch takes this long in clock time, so polls and edits land mid-fetch.
    latencyMs: Schema.optional(Schema.Literals([0, 2_500, 4_500])),
    operations: Schema.Array(Operation),
});
// Focused generators: each explores one family of interleavings densely.
const FreshnessScenario = scenario(
    Schema.Union([ops.edit, ops.advance, ops.read, ops.hold, ops.release, ops.pass, ops.revalidate]),
    {
        stale: Schema.Boolean,
        poll: Schema.Boolean,
        serial: Schema.Boolean,
        background: Schema.Literal(false),
        capture: Schema.Literal("end"),
    }
);
const OrderScenario = scenario(Schema.Union([ops.edit, ops.read, ops.hold, ops.release, ops.revalidate]), {
    stale: Schema.Boolean,
    poll: Schema.Literal(false),
    serial: Schema.Boolean,
    background: Schema.Literal(false),
    capture: Schema.Literal("start"),
});
const ActionScenario = scenario(
    Schema.Union([
        ops.edit,
        ops.read,
        ops.hold,
        ops.release,
        ops.advance,
        ops.increment,
        ops.lostReadBack,
        ops.pass,
    ]),
    {
        stale: Schema.Boolean,
        poll: Schema.Literal(false),
        serial: Schema.Boolean,
        background: Schema.Boolean,
        capture: Schema.Literal("end"),
    }
);

// Liveness: fetches slower than the poll interval, so every one is overtaken by a
// tick, and reads keep arriving. Each read must still finish while polls continue.
// Serial scheduling is excluded: it is a safety reference, and its queued passes each
// reload every invalidated demand in turn, which is slow by design.
const LivenessScenario = scenario(Schema.Union([ops.edit, ops.read, ops.advance, ops.revalidate, ops.pass]), {
    stale: Schema.Boolean,
    poll: Schema.Literal(true),
    serial: Schema.Literal(false),
    background: Schema.Boolean,
    capture: Schema.Literal("end"),
    latencyMs: Schema.Literals([2_500, 4_500]),
});

const run = (scenario: typeof Scenario.Type) =>
    Effect.scoped(
        Effect.gen(function* () {
            const bound = scenario.stale ? maxStaleAgeMs : maxCoverageAgeMs;
            let version = 0;
            const server = new Map<string, Item>();
            // Every state each row has had, with the time it began.
            const history = new Map<string, Array<{ time: number; row: Item | undefined }>>(
                ids.map((id) => [id, [{ time: 0, row: undefined }]])
            );
            const write = Effect.fnUntraced(function* (row: Omit<Item, "version">) {
                const next = { ...row, version: ++version };
                server.set(row.id, next);
                history.get(row.id)!.push({ time: yield* Clock.currentTimeMillis, row: next });
            });
            yield* write({ id: "i0", value: 0, group: "a" });
            yield* write({ id: "i1", value: 0, group: "b" });
            const holds = {
                loads: false,
                actions: undefined as Deferred.Deferred<void> | undefined,
            };
            // Each load fetched while loads are held waits for its own release.
            const heldLoads: Array<Deferred.Deferred<void>> = [];
            // The source version each committed action produced.
            const committedAt = new Map<string, number>();
            let latency = scenario.latencyMs ?? 0;
            let failReadBack = false;
            let committedSinceFailure = false;
            const backend = makeOntologyBackend({
                ir,
                name: "stale-oracle",
                sourceId: "stale-oracle",
                supportsIdempotency: false,
                queryFunction: () => Effect.void,
                refresh: () => ({ pollIntervalMs: scenario.poll ? pollIntervalMs : false }),
                loadSubset: (request) =>
                    Effect.gen(function* () {
                        const subset = yield* compileObjectSubset(ir, request);
                        // The first primary-key list request after a commit is its read-back.
                        if (failReadBack && committedSinceFailure && subset.query?.where?.kind === "in") {
                            failReadBack = false;
                            return yield* new BackendError({
                                operation: "loadSubset",
                                kind: "Unavailable",
                                message: "Read-back failed.",
                                retryable: true,
                            });
                        }
                        const read = () =>
                            evaluateQuery(
                                [...server.values()].map((row) => ({ key: row.id, value: { ...row } })),
                                subset.query ?? {}
                            );
                        const early = scenario.capture === "start" ? read() : undefined;
                        if (latency) yield* Effect.sleep(latency);
                        if (holds.loads) {
                            const held = yield* Deferred.make<void>();
                            heldLoads.push(held);
                            yield* Deferred.await(held);
                        }
                        return { complete: true, rows: early ?? read() };
                    }),
                applyAction: (request) =>
                    Effect.gen(function* () {
                        const id = String(request.parameters.id);
                        const row = server.get(id);
                        if (row) {
                            yield* write({ ...row, value: row.value + 1 });
                            committedAt.set(request.id, version);
                            committedSinceFailure = true;
                        }
                        // Committed at the source before the receipt reaches the replica.
                        if (holds.actions) yield* Deferred.await(holds.actions);
                        return {
                            operationId: request.id,
                            outcome: "committed" as const,
                            affected: row ? [{ objectType: "Item", keys: [id] }] : [],
                        };
                    }),
            });
            const replica = yield* makeReplica({
                namespace: "stale-oracle",
                ir,
                tables: yield* Memory.make(),
                backend,
                startSync: scenario.background,
                objectCacheGc: false,
                ...(scenario.serial ? { scheduling: "serial" as const } : {}),
                demand: { refresh: { maxCoverageAgeMs, maxStaleAgeMs: scenario.stale ? maxStaleAgeMs : 0 } },
                execute: (tx, action) =>
                    Effect.gen(function* () {
                        const row = yield* tx.get("Item", String(action.parameters.id));
                        if (row) yield* tx.put("Item", { ...row, value: Number(row.value) + 1 });
                    }),
            });

            let violation: string | undefined;
            const fail = (message: string) => {
                violation ??= message;
            };
            const project = (subset: CompiledSubset, row: Item | undefined) =>
                row && evaluateQuery([{ key: row.id, value: row }], subset.query ?? {}).length
                    ? row
                    : undefined;
            // Some state of this row, as the subset sees it, held at an instant in (now - age, now].
            const recent = (
                id: string,
                subset: CompiledSubset,
                observed: Item | undefined,
                now: number,
                age: number
            ) => {
                const states = history.get(id)!;
                return states.some((state, index) => {
                    const end = states[index + 1]?.time ?? Infinity;
                    return (
                        state.time <= now &&
                        end > now - age &&
                        JSON.stringify(project(subset, state.row)) === JSON.stringify(observed)
                    );
                });
            };
            const demanded = new Set<string>();
            // Status reports canonical queries; recognize the three fixture subsets.
            const subsetName = (entry: { readonly query?: { readonly where?: unknown } }) => {
                const where = JSON.stringify(entry.query?.where ?? null);
                return where === "null" ? "whole" : where.includes('"group"') ? "groupA" : "point";
            };
            const reads: Array<Fiber.Fiber<void, unknown>> = [];
            const read = (name: string) =>
                Effect.gen(function* () {
                    const subset = subsets[name]!;
                    if (!demanded.has(name)) {
                        demanded.add(name);
                        yield* replica.demand(subset);
                    }
                    const fiber = yield* Effect.forkScoped(
                        Effect.gen(function* () {
                            const synced = yield* Effect.result(replica.syncSubset(subset));
                            if (synced._tag === "Failure")
                                return fail(`${name}: read failed ${synced.failure.kind}`);
                            const now = yield* Clock.currentTimeMillis;
                            const demand = (yield* replica.status).demands.find(
                                (entry) => subsetName(entry) === name
                            );
                            const proof = demand?.coverageProof;
                            const rows = new Map(
                                (yield* replica.snapshotSubset({
                                    ...subset,
                                    query: subset.query ?? {},
                                })).rows.map((row) => [String(row.key), row.value as Item])
                            );
                            if (proof?.stale && !(now - proof.confirmedAt! < maxStaleAgeMs))
                                fail(
                                    `${name}: stale proof confirmed at ${proof.confirmedAt} served at ${now}`
                                );
                            if (proof?.stale && !scenario.stale)
                                fail(`${name}: stale proof without maxStaleAgeMs`);
                            const age = proof && !proof.stale ? maxCoverageAgeMs : bound;
                            // A read can also return uncovered (offline, or while a commit awaits
                            // confirmation); only a read its demand reports as installed is bounded.
                            if (!demand || demand.installed !== demand.revision) return;
                            // Passes step aside for an unsettled action, so such a read returns
                            // whatever is cached, as before gate-free loading.
                            if (
                                (yield* replica.pending).some(
                                    (entry) =>
                                        entry.state === "sending" || entry.receipt?.outcome === "committed"
                                )
                            )
                                return;
                            if (scenario.capture === "start") return;
                            for (const id of ids)
                                if (!recent(id, subset, rows.get(id), now, age))
                                    fail(
                                        `${name}: ${id} ${JSON.stringify(rows.get(id))} outside ${age} ms at ${now}`
                                    );
                        })
                    );
                    reads.push(fiber);
                });
            const passes: Array<Fiber.Fiber<unknown>> = [];
            const seen = new Map<string, number>();
            const monotonic = Effect.gen(function* () {
                const pending = yield* replica.pending;
                for (const id of ids) {
                    const row = (yield* replica.confirmed.get("Item", id)) as Item | undefined;
                    if (!row) continue;
                    if (row.version < (seen.get(id) ?? 0)) fail(`${id}: version ${row.version} regressed`);
                    seen.set(id, Math.max(row.version, seen.get(id) ?? 0));
                    // A prediction still applied over a base that already contains its commit
                    // shows the action twice.
                    for (const entry of pending)
                        if (
                            String(entry.invocation.parameters.id) === id &&
                            entry.prediction === "applied" &&
                            (committedAt.get(entry.invocation.id) ?? Infinity) <= row.version
                        )
                            fail(`${id}: ${entry.invocation.id} applied twice over version ${row.version}`);
                }
            });
            // Let forked reads, passes and background fibers run at the current instant.
            const progress = Effect.gen(function* () {
                for (let step = 0; step < 40; step++) {
                    yield* TestClock.adjust(0);
                    yield* Effect.yieldNow;
                }
            });
            const release = (order: "oldest" | "newest") =>
                Effect.gen(function* () {
                    holds.loads = false;
                    const held = holds.actions;
                    holds.actions = undefined;
                    if (held) yield* Deferred.succeed(held, undefined);
                    // Let each resumed load install before the next one resumes.
                    while (heldLoads.length) {
                        const next = order === "oldest" ? heldLoads.shift()! : heldLoads.pop()!;
                        yield* Deferred.succeed(next, undefined);
                        yield* progress;
                        yield* monotonic;
                    }
                });
            let sequence = 0;
            let obstructed = false;
            for (const operation of scenario.operations) {
                if (operation.kind === "edit")
                    yield* write({ id: operation.id, value: operation.value, group: operation.group });
                else if (operation.kind === "advance") yield* TestClock.adjust(operation.ms);
                else if (operation.kind === "read") yield* read(operation.subset);
                else if (operation.kind === "hold") {
                    if (operation.what === "loads") holds.loads = true;
                    else holds.actions ??= yield* Deferred.make<void>();
                } else if (operation.kind === "release") yield* release(operation.order);
                else if (operation.kind === "pass") {
                    // An action still sending, or committed but unconfirmed, holds back snapshots.
                    obstructed = (yield* replica.pending).some(
                        (entry) => entry.state === "sending" || entry.receipt?.outcome === "committed"
                    );
                    passes.push(yield* Effect.forkScoped(Effect.result(replica.syncOnce)));
                } else if (operation.kind === "revalidate") yield* replica.markDemandedStale;
                else if (operation.kind === "lostReadBack") {
                    failReadBack = true;
                    committedSinceFailure = false;
                } else {
                    const known = (yield* replica.get("Item", operation.id)) !== undefined;
                    if (known)
                        yield* replica.enqueue({
                            id: `increment-${sequence++}`,
                            name: "increment",
                            parameters: { id: operation.id },
                        });
                }
                yield* progress;
                yield* monotonic;
                // A pass that nothing obstructs revalidates every stale proof it served.
                if (
                    operation.kind === "pass" &&
                    !holds.loads &&
                    !holds.actions &&
                    passes.every((fiber) => fiber.pollUnsafe() !== undefined) &&
                    !obstructed
                ) {
                    for (const demand of (yield* replica.status).demands)
                        if (demand.coverageProof?.stale)
                            fail(`${subsetName(demand)}: still stale after an unobstructed pass`);
                }
                if (violation) break;
            }
            // With polls still firing, every read finishes within a few fetch latencies:
            // invalidation mid-fetch may delay a load, never starve it.
            if (scenario.latencyMs && !violation) {
                const deadline = 6 * scenario.latencyMs + pollIntervalMs;
                for (let waited = 0; waited < deadline; waited += 500) {
                    yield* TestClock.adjust(500);
                    yield* progress;
                    yield* monotonic;
                }
                const stuck = reads.filter((fiber) => fiber.pollUnsafe() === undefined).length;
                if (stuck) fail(`${stuck} read(s) unfinished ${deadline} ms into continuous polling`);
                if (violation) return yield* Effect.fail(new Error(violation));
                // Converge without latency; let fetches already sleeping land.
                latency = 0;
                yield* TestClock.adjust(scenario.latencyMs);
                yield* progress;
            }
            // Everything released, every read and pass completes.
            yield* release("oldest");
            yield* progress;
            for (const fiber of [...reads, ...passes]) yield* Fiber.join(fiber);
            yield* monotonic;
            // After a full refresh with nothing held, every demand shows the source.
            failReadBack = false;
            yield* TestClock.adjust(maxStaleAgeMs * 2);
            // A read-back that failed earlier is confirmed by the first checkpoint.
            yield* Effect.result(replica.syncOnce);
            yield* replica.syncOnce;
            yield* replica.syncOnce;
            for (const name of demanded) {
                const subset = subsets[name]!;
                yield* replica.syncSubset(subset);
                const rows = (yield* replica.snapshotSubset({ ...subset, query: subset.query ?? {} })).rows;
                const expected = ids.flatMap((id) => {
                    const row = project(subset, server.get(id));
                    return row ? [row] : [];
                });
                if (
                    JSON.stringify(
                        rows
                            .map((row) => row.value)
                            .sort((a, b) => String((a as Item).id).localeCompare(String((b as Item).id)))
                    ) !== JSON.stringify(expected)
                )
                    fail(`${name}: did not converge`);
            }
            // A typed failure keeps the violated invariant in the shrunk report.
            if (violation) return yield* Effect.fail(new Error(violation));
            return true;
        })
    );

const asScenario = (value: unknown) => value as typeof Scenario.Type;
it.effect.prop(
    "reads stay within their freshness bound under loads, polls and revalidation",
    [FreshnessScenario],
    ([value]) => run(asScenario(value)),
    { arbitrary: { runs: 200, size: 24, seed: "stale-coverage-freshness-v1" }, timeout: 120_000 }
);
it.effect.prop(
    "a row's confirmed version never regresses when overlapping loads finish out of order",
    [OrderScenario],
    ([value]) => run(asScenario(value)),
    { arbitrary: { runs: 200, size: 24, seed: "stale-coverage-order-v1" }, timeout: 120_000 }
);
it.effect.prop(
    "snapshots never apply an action twice while its commit awaits confirmation",
    [ActionScenario],
    ([value]) => run(asScenario(value)),
    { arbitrary: { runs: 200, size: 24, seed: "stale-coverage-actions-v1" }, timeout: 120_000 }
);
it.effect.prop(
    "reads finish while polls keep invalidating loads slower than the poll interval",
    [LivenessScenario],
    ([value]) => run(asScenario(value)),
    { arbitrary: { runs: 100, size: 24, seed: "stale-coverage-liveness-v1" }, timeout: 120_000 }
);

it.effect("a read during a held refresh of a stale collection is served within the bound", () =>
    Effect.gen(function* () {
        const agreed = yield* run({
            stale: true,
            poll: false,
            serial: false,
            background: false,
            capture: "end",
            operations: [
                { kind: "read", subset: "whole" },
                { kind: "advance", ms: 1_200 },
                { kind: "edit", id: "i0", value: 5, group: "a" },
                { kind: "hold", what: "loads" },
                { kind: "pass" },
                { kind: "read", subset: "point" },
                { kind: "read", subset: "groupA" },
                { kind: "advance", ms: 3_000 },
                { kind: "read", subset: "whole" },
                { kind: "release", order: "newest" },
            ],
        });
        expect(agreed).toBe(true);
    })
);

it.effect("an older fetch that finishes last never replaces a newer row", () =>
    Effect.gen(function* () {
        const agreed = yield* run({
            stale: true,
            poll: false,
            serial: false,
            background: false,
            capture: "start",
            // The group's fetch starts first; the whole collection, which does not wait
            // for it, sees the later edit. Both finish together, in either order.
            operations: [
                { kind: "hold", what: "loads" },
                { kind: "read", subset: "groupA" },
                { kind: "edit", id: "i0", value: 7, group: "a" },
                { kind: "read", subset: "whole" },
                { kind: "release", order: "newest" },
            ],
        });
        expect(agreed).toBe(true);
    })
);

it.effect("a load fetched after a commit waits for its receipt before installing", () =>
    Effect.gen(function* () {
        const agreed = yield* run({
            stale: true,
            poll: false,
            serial: false,
            background: false,
            capture: "end",
            operations: [
                { kind: "read", subset: "whole" },
                { kind: "increment", id: "i0" },
                { kind: "lostReadBack" },
                { kind: "pass" },
                { kind: "advance", ms: 1_200 },
                { kind: "read", subset: "whole" },
                { kind: "pass" },
            ],
        });
        expect(agreed).toBe(true);
    })
);

it.effect("a load in flight across a commit never installs over its unconfirmed receipt", () =>
    Effect.gen(function* () {
        const agreed = yield* run({
            stale: false,
            poll: false,
            serial: false,
            background: true,
            capture: "end",
            // The group's fetch is held while the worker commits an edit to one of its
            // rows and then loses the receipt's read-back.
            operations: [
                { kind: "read", subset: "point" },
                { kind: "hold", what: "loads" },
                { kind: "read", subset: "groupA" },
                { kind: "lostReadBack" },
                { kind: "increment", id: "i0" },
                { kind: "release", order: "oldest" },
                { kind: "advance", ms: 8_000 },
            ],
        });
        expect(agreed).toBe(true);
    })
);
