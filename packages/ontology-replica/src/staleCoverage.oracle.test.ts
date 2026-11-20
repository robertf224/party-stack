import { it } from "@effect/vitest";
import { BackendError, makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { eq, evaluateQuery, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Schema, Scope } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { makeReplica } from "./testing.js";
import type { CompiledSubset } from "@party-stack/ontology-backend/subset";

// Oracle: the source's own history. Under any interleaving of source edits, clock
// jumps, poll ticks, held loads, held action dispatches, demand releases, cache
// collection, failed fetches, restarts (with the device clock corrected) and reads, a read that
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
    // Held loads resume one at a time: in start order, or newest first. "one" resumes
    // only the oldest and keeps the rest held, so other operations land between installs.
    release: Schema.Struct({
        kind: Schema.Literal("release"),
        order: Schema.Literals(["oldest", "newest", "one"]),
    }),
    // An explicit checkpoint: load what is due, then dispatch the outbox.
    pass: Schema.Struct({ kind: Schema.Literal("pass") }),
    revalidate: Schema.Struct({ kind: Schema.Literal("revalidate") }),
    increment: Schema.Struct({ kind: Schema.Literal("increment"), id: Id }),
    // The next receipt's read-back fails, leaving its commit unconfirmed until a later pass.
    lostReadBack: Schema.Struct({ kind: Schema.Literal("lostReadBack") }),
    // The last consumer of a subset leaves; a later read acquires it again. With
    // `collect`, the cache is collected right after, while the subset is unprotected.
    drop: Schema.Struct({
        kind: Schema.Literal("drop"),
        subset: Schema.Literals(["whole", "groupA", "point"]),
        collect: Schema.Boolean,
    }),
    // Collect every cached row nothing protects.
    gc: Schema.Struct({ kind: Schema.Literal("gc") }),
    // The next subset fetch (not a read-back) fails.
    // "defect": the adapter throws instead of failing with a `BackendError`.
    failFetch: Schema.Struct({
        kind: Schema.Literal("failFetch"),
        failure: Schema.Literals(["retryable", "terminal", "defect"]),
    }),
    // The app restarts on the same storage. Its device clock may have been corrected
    // meanwhile: the replica's clock then reads this much more than before.
    // -8 s exceeds the stale bound, so stale serving is exercised too.
    reopen: Schema.Struct({
        kind: Schema.Literal("reopen"),
        skewMs: Schema.Literals([0, -3_000, -8_000, 3_000]),
    }),
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
    // Each dispatch commits at the source, then takes this long to return its receipt.
    actionLatencyMs: Schema.optional(Schema.Literals([0, 1_000, 3_000])),
    // During the liveness window, an increment is enqueued this often.
    editEveryMs: Schema.optional(Schema.Literals([0, 1_000])),
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

// Lifecycle: consumers come and go, the cache is collected, fetches fail and the app
// restarts, alongside loads, edits and actions. Reads stay within their bound, versions
// never regress and the replica converges.
const LifecycleScenario = scenario(
    Schema.Union([
        ops.edit,
        ops.advance,
        ops.read,
        ops.hold,
        ops.release,
        ops.pass,
        ops.revalidate,
        ops.increment,
        ops.drop,
        ops.gc,
        ops.failFetch,
        ops.reopen,
    ]),
    {
        stale: Schema.Boolean,
        poll: Schema.Boolean,
        serial: Schema.Boolean,
        background: Schema.Boolean,
        capture: Schema.Literal("end"),
    }
);

// Collection: consumers leave and the cache is collected between reads, edits and
// short clock moves, so a re-read often lands while old coverage would still be fresh.
const CollectionScenario = scenario(
    Schema.Union([
        ops.read,
        ops.drop,
        ops.gc,
        ops.edit,
        ops.hold,
        Schema.Struct({ kind: Schema.Literal("release"), order: Schema.Literal("one") }),
        Schema.Struct({ kind: Schema.Literal("advance"), ms: Schema.Literals([0, 1_200]) }),
    ]),
    {
        stale: Schema.Boolean,
        poll: Schema.Literal(false),
        serial: Schema.Boolean,
        background: Schema.Literal(false),
        capture: Schema.Literal("end"),
    }
);

// Restarts: the app reopens on the same storage, sometimes with its clock corrected.
const RestartScenario = scenario(
    Schema.Union([
        ops.read,
        ops.edit,
        Schema.Struct({ kind: Schema.Literal("advance"), ms: Schema.Literals([0, 1_200]) }),
        ops.reopen,
        ops.pass,
        ops.increment,
    ]),
    {
        stale: Schema.Boolean,
        poll: Schema.Boolean,
        serial: Schema.Boolean,
        background: Schema.Boolean,
        capture: Schema.Literal("end"),
    }
);

// Liveness: fetches slower than the poll interval, so every one is overtaken by a
// tick, and reads keep arriving. Each read must still finish while polls continue.
// Serial scheduling is excluded: it is a safety reference, and its queued passes each
// reload every invalidated demand in turn, which is slow by design.
const LivenessScenario = scenario(
    Schema.Union([
        ops.edit,
        ops.read,
        ops.advance,
        ops.revalidate,
        ops.pass,
        ops.drop,
        ops.gc,
        ops.failFetch,
    ]),
    {
        stale: Schema.Boolean,
        poll: Schema.Literal(true),
        serial: Schema.Literal(false),
        background: Schema.Boolean,
        capture: Schema.Literal("end"),
        latencyMs: Schema.Literals([2_500, 4_500]),
    }
);

// Liveness under continuous edits: actions keep dispatching while slow fetches land,
// so some action is nearly always sending or awaiting confirmation. Every demanded
// subset must still be proven at some point, and every read must finish.
const EditsScenario = scenario(Schema.Union([ops.edit, ops.read, ops.advance, ops.increment, ops.pass]), {
    stale: Schema.Boolean,
    poll: Schema.Boolean,
    serial: Schema.Literal(false),
    background: Schema.Literal(true),
    capture: Schema.Literal("end"),
    latencyMs: Schema.Literal(2_500),
    actionLatencyMs: Schema.Literals([1_000, 3_000]),
    editEveryMs: Schema.Literal(1_000),
});

// The replica runs on the device clock, which a restart may find corrected by
// `skew`; the oracle judges freshness by the source's clock.
const run = (scenario: typeof Scenario.Type) =>
    Effect.gen(function* () {
        const source = (yield* Clock.Clock) as TestClock.TestClock;
        const device = { skew: 0 };
        const millis = () => source.currentTimeMillisUnsafe() + device.skew;
        const nanos = () => source.currentTimeNanosUnsafe() + BigInt(device.skew) * 1_000_000n;
        const clock: TestClock.TestClock = {
            currentTimeMillisUnsafe: millis,
            currentTimeMillis: Effect.sync(millis),
            currentTimeNanosUnsafe: nanos,
            currentTimeNanos: Effect.sync(nanos),
            monotonicTimeNanosUnsafe: () => source.monotonicTimeNanosUnsafe(),
            monotonicTimeNanos: source.monotonicTimeNanos,
            sleep: (duration) => source.sleep(duration),
            adjust: (duration) => source.adjust(duration),
            setTime: (timestamp) => source.setTime(timestamp),
            withLive: (effect) => source.withLive(effect),
        };
        return yield* simulate(scenario, source, device).pipe(Effect.provideService(Clock.Clock, clock));
    });

const simulate = (scenario: typeof Scenario.Type, source: Clock.Clock, device: { skew: number }) =>
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
                history.get(row.id)!.push({ time: source.currentTimeMillisUnsafe(), row: next });
            });
            yield* write({ id: "i0", value: 0, group: "a" });
            yield* write({ id: "i1", value: 0, group: "b" });
            // The seed precedes the replica: no read can observe the rows' absence before it.
            for (const id of ["i0", "i1"]) history.set(id, history.get(id)!.slice(1));
            const holds = {
                loads: false,
                actions: undefined as Deferred.Deferred<void> | undefined,
            };
            // Each load fetched while loads are held waits for its own release.
            const heldLoads: Array<Deferred.Deferred<void>> = [];
            // The source version each committed action produced.
            const committedAt = new Map<string, number>();
            let latency = scenario.latencyMs ?? 0;
            let actionLatency = scenario.actionLatencyMs ?? 0;
            let failReadBack = false;
            let committedSinceFailure = false;
            let failNext: "retryable" | "terminal" | "defect" | undefined;
            // Kinds of the fetch failures injected so far; a read may fail with one of them.
            const injectedKinds = new Set<string>();
            let failuresFired = 0;
            let terminalInjected = false;
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
                        if (failNext && subset.query?.where?.kind !== "in") {
                            const injected = failNext;
                            const retryable = injected === "retryable";
                            failNext = undefined;
                            failuresFired++;
                            if (injected === "defect") return yield* Effect.die(new Error("Adapter bug."));
                            return yield* new BackendError({
                                operation: "loadSubset",
                                kind: retryable ? "Unavailable" : "InvalidRequest",
                                message: "Fetch failed.",
                                retryable,
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
                        if (actionLatency) yield* Effect.sleep(actionLatency);
                        // Committed at the source before the receipt reaches the replica.
                        if (holds.actions) yield* Deferred.await(holds.actions);
                        return {
                            operationId: request.id,
                            outcome: "committed" as const,
                            affected: row ? [{ objectType: "Item", keys: [id] }] : [],
                        };
                    }),
            });
            const tables = yield* Memory.make();
            const open = Effect.gen(function* () {
                const scope = yield* Scope.make();
                const replica = yield* makeReplica({
                    namespace: "stale-oracle",
                    ir,
                    tables,
                    backend,
                    startSync: scenario.background,
                    objectCacheGc: false,
                    ...(scenario.serial ? { scheduling: "serial" as const } : {}),
                    demand: {
                        idleRetentionMs: 0,
                        refresh: { maxCoverageAgeMs, maxStaleAgeMs: scenario.stale ? maxStaleAgeMs : 0 },
                    },
                    execute: (tx, action) =>
                        Effect.gen(function* () {
                            const row = yield* tx.get("Item", String(action.parameters.id));
                            if (row) yield* tx.put("Item", { ...row, value: Number(row.value) + 1 });
                        }),
                }).pipe(Scope.provide(scope));
                return { replica, scope };
            });
            let { replica, scope: replicaScope } = yield* open;

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
            // Each demanded subset's long-lived consumer; `drop` ends it.
            const leases = new Map<string, Scope.Closeable>();
            const drops = new Map<string, number>();
            const lease = (name: string) =>
                Effect.gen(function* () {
                    demanded.add(name);
                    if (leases.has(name)) return;
                    const scope = yield* Scope.make();
                    leases.set(name, scope);
                    yield* replica.demand(subsets[name]!).pipe(Scope.provide(scope));
                });
            // Status reports canonical queries; recognize the three fixture subsets.
            const subsetName = (entry: { readonly query?: { readonly where?: unknown } }) => {
                const where = JSON.stringify(entry.query?.where ?? null);
                return where === "null" ? "whole" : where.includes('"group"') ? "groupA" : "point";
            };
            const reads: Array<Fiber.Fiber<void, unknown>> = [];
            const read = (name: string) =>
                Effect.gen(function* () {
                    const subset = subsets[name]!;
                    yield* lease(name);
                    const dropped = drops.get(name) ?? 0;
                    const fiber = yield* Effect.forkScoped(
                        Effect.gen(function* () {
                            const synced = yield* Effect.result(replica.syncSubset(subset));
                            // An injected fetch failure may fail a read, and so may releasing
                            // the subset it was reading.
                            if (synced._tag === "Failure") {
                                if (
                                    injectedKinds.has(synced.failure.kind) ||
                                    (drops.get(name) ?? 0) !== dropped
                                )
                                    return;
                                return fail(`${name}: read failed ${synced.failure.kind}`);
                            }
                            const now = source.currentTimeMillisUnsafe();
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
                            if (proof?.stale && !(now + device.skew - proof.confirmedAt! < maxStaleAgeMs))
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
            const release = (order: "oldest" | "newest" | "one") =>
                Effect.gen(function* () {
                    if (order === "one") {
                        const next = heldLoads.shift();
                        if (next) yield* Deferred.succeed(next, undefined);
                        return;
                    }
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
            let firedAtPass = 0;
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
                    firedAtPass = failuresFired;
                    obstructed = (yield* replica.pending).some(
                        (entry) => entry.state === "sending" || entry.receipt?.outcome === "committed"
                    );
                    passes.push(yield* Effect.forkScoped(Effect.result(replica.syncOnce)));
                } else if (operation.kind === "revalidate") yield* replica.markDemandedStale;
                else if (operation.kind === "lostReadBack") {
                    failReadBack = true;
                    committedSinceFailure = false;
                } else if (operation.kind === "drop") {
                    const scope = leases.get(operation.subset);
                    if (scope) {
                        leases.delete(operation.subset);
                        drops.set(operation.subset, (drops.get(operation.subset) ?? 0) + 1);
                        yield* Scope.close(scope, Exit.void);
                    }
                    if (operation.collect) {
                        yield* progress;
                        yield* Effect.result(replica.collectGarbage({ minUnusedAgeMs: 0 }));
                    }
                } else if (operation.kind === "gc")
                    yield* Effect.result(replica.collectGarbage({ minUnusedAgeMs: 0 }));
                else if (operation.kind === "failFetch") {
                    failNext = operation.failure;
                    // The replica reports an adapter defect as an `Internal` failure.
                    injectedKinds.add(
                        { retryable: "Unavailable", terminal: "InvalidRequest", defect: "Internal" }[
                            operation.failure
                        ]
                    );
                    terminalInjected ||= operation.failure !== "retryable";
                } else if (operation.kind === "reopen") {
                    // The app closes: its reads and passes end with it.
                    for (const fiber of [...reads, ...passes]) yield* Fiber.interrupt(fiber);
                    reads.length = 0;
                    passes.length = 0;
                    yield* release("oldest");
                    const reacquire = [...leases.keys()];
                    for (const scope of leases.values()) yield* Scope.close(scope, Exit.void);
                    leases.clear();
                    yield* Scope.close(replicaScope, Exit.void);
                    device.skew += operation.skewMs;
                    ({ replica, scope: replicaScope } = yield* open);
                    for (const name of reacquire) yield* lease(name);
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
                    !obstructed &&
                    // A failed refresh leaves its stale proof visible.
                    failuresFired === firedAtPass
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
                // Each of a load's (at most three) fetches may wait one action's turn
                // (dispatch plus read-back) to install, and a contained subset may wait
                // for its containing load first.
                const turn = scenario.editEveryMs ? (scenario.actionLatencyMs ?? 0) + scenario.latencyMs : 0;
                const deadline = 6 * (scenario.latencyMs + turn) + pollIntervalMs;
                const proven = new Set<string>();
                for (let waited = 0; waited < deadline; waited += 500) {
                    if (scenario.editEveryMs && waited % scenario.editEveryMs === 0) {
                        const id = ids[(waited / scenario.editEveryMs) % ids.length]!;
                        yield* replica.enqueue({
                            id: `increment-${sequence++}`,
                            name: "increment",
                            parameters: { id },
                        });
                    }
                    // With edits under way, read every subset, then invalidate them all:
                    // each must load again and install while the outbox stays busy.
                    if (scenario.editEveryMs && waited === 500)
                        for (const name of Object.keys(subsets)) yield* read(name);
                    if (scenario.editEveryMs && waited === 1_000) yield* replica.invalidate();
                    yield* TestClock.adjust(500);
                    yield* progress;
                    yield* monotonic;
                    if (waited >= 1_000)
                        for (const demand of (yield* replica.status).demands)
                            if (demand.installed === demand.revision) proven.add(subsetName(demand));
                }
                const stuck = reads.filter((fiber) => fiber.pollUnsafe() === undefined).length;
                if (stuck) fail(`${stuck} read(s) unfinished ${deadline} ms into continuous interference`);
                // Without stale serving, polls faster than a load leave no instant at
                // which coverage is current, under either scheduling.
                if (scenario.editEveryMs && (!scenario.poll || scenario.stale))
                    for (const name of demanded)
                        if (!proven.has(name)) fail(`${name}: never proven while edits continued`);
                if (violation) return yield* Effect.fail(new Error(violation));
                // Converge without latency; let fetches already sleeping land.
                latency = 0;
                actionLatency = 0;
                yield* TestClock.adjust(scenario.latencyMs + (scenario.actionLatencyMs ?? 0));
                yield* progress;
            }
            // Waits for an effect while the clock keeps moving, so a stuck one is reported
            // (and shrunk) instead of hanging the test.
            const settle = <A, E>(label: string, effect: Effect.Effect<A, E>) =>
                Effect.gen(function* () {
                    const fiber = yield* Effect.forkScoped(effect);
                    for (let waited = 0; waited < 60_000 && !fiber.pollUnsafe(); waited += 1_000) {
                        yield* progress;
                        if (!fiber.pollUnsafe()) yield* TestClock.adjust(1_000);
                    }
                    const exit = fiber.pollUnsafe();
                    if (!exit) {
                        fail(`${label} never finished`);
                        yield* Fiber.interrupt(fiber);
                        return undefined;
                    }
                    // A replica operation may fail, never die.
                    if (Exit.hasDies(exit)) {
                        fail(`${label} died: ${Cause.pretty(exit.cause).split("\n")[0]}`);
                        return undefined;
                    }
                    return yield* Fiber.join(fiber);
                });
            // Everything released, every read and pass completes.
            yield* release("oldest");
            yield* progress;
            yield* settle(
                "a read or pass",
                Effect.forEach([...reads, ...passes], (fiber) =>
                    Effect.flatMap(Fiber.await(fiber), (exit) =>
                        Exit.hasDies(exit) ? Effect.die(Cause.squash(exit.cause)) : Effect.void
                    )
                )
            );
            if (violation) return yield* Effect.fail(new Error(violation));
            yield* monotonic;
            // After a full refresh with nothing held, every demand shows the source.
            failReadBack = false;
            failNext = undefined;
            // A terminal failure stays with its demand; a new consumer starts over.
            if (terminalInjected) {
                for (const scope of leases.values()) yield* Scope.close(scope, Exit.void);
                leases.clear();
            }
            for (const name of demanded) yield* lease(name);
            yield* TestClock.adjust(maxStaleAgeMs * 2);
            // A read-back that failed earlier is confirmed by the first checkpoint.
            yield* settle("a checkpoint", Effect.result(replica.syncOnce));
            yield* settle("a checkpoint", replica.syncOnce);
            yield* settle("a checkpoint", replica.syncOnce);
            for (const name of demanded) {
                const subset = subsets[name]!;
                yield* settle(`${name}: converging read`, replica.syncSubset(subset));
                if (violation) return yield* Effect.fail(new Error(violation));
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
    "reads stay bounded and converge while consumers leave, the cache is collected, fetches fail and the app restarts",
    [LifecycleScenario],
    ([value]) => run(asScenario(value)),
    { arbitrary: { runs: 200, size: 24, seed: "stale-coverage-lifecycle-v1" }, timeout: 120_000 }
);
it.effect.prop(
    "a re-read after its consumers left and the cache was collected loads what was collected",
    [CollectionScenario],
    ([value]) => run(asScenario(value)),
    { arbitrary: { runs: 200, size: 24, seed: "stale-coverage-collection-v1" }, timeout: 120_000 }
);
it.effect.prop(
    "reads after a restart stay within their bound, even when the device clock was corrected",
    [RestartScenario],
    ([value]) => run(asScenario(value)),
    { arbitrary: { runs: 200, size: 24, seed: "stale-coverage-restart-v1" }, timeout: 120_000 }
);
it.effect.prop(
    "reads finish while polls keep invalidating loads slower than the poll interval",
    [LivenessScenario],
    ([value]) => run(asScenario(value)),
    { arbitrary: { runs: 100, size: 24, seed: "stale-coverage-liveness-v1" }, timeout: 120_000 }
);
it.effect.prop(
    "demanded subsets are proven and reads finish while edits keep dispatching",
    [EditsScenario],
    ([value]) => run(asScenario(value)),
    { arbitrary: { runs: 50, size: 24, seed: "stale-coverage-edits-v1" }, timeout: 120_000 }
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

it.effect("coverage confirmed ahead of a corrected clock is not treated as fresh", () =>
    Effect.gen(function* () {
        for (const stale of [false, true]) {
            const agreed = yield* run({
                stale,
                poll: false,
                serial: false,
                background: false,
                capture: "end",
                // Coverage is confirmed at 3 s; after a restart the device clock reads 8 s
                // less, so that coverage looks confirmed in the future. The source changes
                // at once; read 6 s later, the cached row is older than either bound.
                operations: [
                    { kind: "read", subset: "whole" },
                    { kind: "advance", ms: 3_000 },
                    { kind: "read", subset: "whole" },
                    { kind: "reopen", skewMs: -8_000 },
                    { kind: "edit", id: "i0", value: 5, group: "a" },
                    { kind: "advance", ms: 3_000 },
                    { kind: "advance", ms: 3_000 },
                    { kind: "read", subset: "whole" },
                ],
            });
            expect(agreed).toBe(true);
        }
    })
);

it.effect("collected rows take their coverage with them", () =>
    Effect.gen(function* () {
        const agreed = yield* run({
            stale: false,
            poll: false,
            serial: false,
            background: false,
            capture: "end",
            // Nothing protects the collection once its consumer leaves; a later read
            // must load it again rather than trust coverage for rows no longer cached.
            operations: [
                { kind: "read", subset: "whole" },
                { kind: "drop", subset: "whole", collect: true },
                { kind: "read", subset: "whole" },
            ],
        });
        expect(agreed).toBe(true);
    })
);
