import { it } from "@effect/vitest";
import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { eq, evaluateQuery, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { makeReplica } from "./testing.js";
import type { DemandRefreshPolicy } from "./demandCache.js";
import type { ReplicaService } from "./testing.js";
import type { OwnedTransaction } from "@party-stack/ontology-backend/owned";

const objectType = (name: string) => ({
    name,
    displayName: name,
    pluralDisplayName: `${name}s`,
    primaryKey: "id",
    properties: [
        { name: "id", displayName: "Id", type: o.string({}) },
        { name: "value", displayName: "Value", type: o.integer({}) },
    ],
});
const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [objectType("Item"), objectType("Tag")],
    actionTypes: [{ name: "write", displayName: "Write", parameters: [], logic: [] }],
};
const whole = { objectType: "Item" };
const point = { objectType: "Item", query: { where: eq(field("id"), "one") } };
const tags = { objectType: "Tag" };

const fixture = Effect.fnUntraced(function* (options: {
    readonly refresh?: DemandRefreshPolicy;
    readonly pollIntervalMs?: number;
    readonly startSync?: boolean;
    readonly maxConcurrentLoads?: number;
}) {
    const tables = yield* Memory.make();
    const events: string[] = [];
    let value = 1;
    let hold:
        | { started: Deferred.Deferred<void>; release: Deferred.Deferred<void>; once: boolean }
        | undefined;
    let applyHold: { started: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined;
    const holdLoads = (once = false) =>
        Effect.gen(function* () {
            const next = {
                started: yield* Deferred.make<void>(),
                release: yield* Deferred.make<void>(),
                once,
            };
            hold = next;
            return {
                started: Deferred.await(next.started),
                release: Effect.sync(() => {
                    if (hold === next) hold = undefined;
                }).pipe(Effect.andThen(Deferred.succeed(next.release, undefined))),
            };
        });
    const holdActions = Effect.gen(function* () {
        const next = { started: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
        applyHold = next;
        return {
            started: Deferred.await(next.started),
            release: Deferred.succeed(next.release, undefined),
        };
    });
    const replica = yield* makeReplica({
        namespace: "stale-while-revalidate",
        ir,
        tables,
        startSync: options.startSync ?? true,
        objectCacheGc: false,
        demand: { refresh: options.refresh, maxConcurrentLoads: options.maxConcurrentLoads },
        execute: (tx: OwnedTransaction) => tx.put("Item", { id: "one", value: 99 }),
        backend: makeOntologyBackend({
            ir,
            name: "fixture",
            sourceId: "fixture",
            supportsIdempotency: false,
            refresh: () => ({ pollIntervalMs: options.pollIntervalMs ?? false }),
            queryFunction: () => Effect.void,
            applyAction: (request) =>
                Effect.gen(function* () {
                    events.push("apply");
                    const held = applyHold;
                    if (held) {
                        applyHold = undefined;
                        yield* Deferred.succeed(held.started, undefined);
                        yield* Deferred.await(held.release);
                    }
                    value = 99;
                    events.push("applied");
                    return {
                        operationId: request.id,
                        outcome: "committed" as const,
                        affected: [{ objectType: "Item", keys: ["one"] }],
                    };
                }),
            loadSubset: (request) =>
                Effect.gen(function* () {
                    const subset = yield* compileObjectSubset(ir, request);
                    events.push(`load:${subset.objectType}`);
                    const held = hold;
                    if (held?.once) hold = undefined;
                    if (held) {
                        yield* Deferred.succeed(held.started, undefined);
                        yield* Deferred.await(held.release);
                    }
                    return {
                        rows: evaluateQuery([{ key: "one", value: { id: "one", value } }], subset.query),
                        complete: true,
                    };
                }),
        }),
    });
    return {
        replica,
        tables,
        events,
        loads: (type = "Item") => events.filter((event) => event === `load:${type}`).length,
        setValue: (next: number) => {
            value = next;
        },
        holdLoads,
        holdActions,
    };
});

const proofOf = (replica: ReplicaService, subset: { objectType: string; query?: object }) =>
    Effect.map(replica.status, (status) => {
        const demand = status.demands.find(
            (entry) =>
                entry.objectType === subset.objectType &&
                (entry.query?.where !== undefined) === (subset.query !== undefined)
        )!;
        return {
            installed: demand.installed === demand.revision,
            proof: demand.coverageProof,
            coveredBy: demand.coveredBy?.objectType,
        };
    });
const settled = (replica: ReplicaService) =>
    replica.statuses.pipe(
        Stream.filter((status) =>
            status.demands.every(
                (demand) => demand.installed === demand.revision && !demand.coverageProof?.stale
            )
        ),
        Stream.runHead
    );
const hasCoverage = (f: Effect.Success<ReturnType<typeof fixture>>, subset: typeof whole) =>
    f.tables.read((tx) => f.replica.hasCoverage(tx, subset));

it.live("a covered demand is admitted while another load is in flight", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture({ startSync: false });
            yield* f.replica.demand(whole);
            yield* f.replica.syncSubset(whole);
            // An uncovered demand starts a pass whose load stays in flight.
            yield* f.replica.demand(tags);
            const held = yield* f.holdLoads();
            const slow = yield* Effect.forkScoped(f.replica.syncSubset(tags));
            yield* held.started;

            yield* f.replica.demand(point);
            yield* f.replica.syncSubset(point).pipe(Effect.timeout("1 second"));
            expect(yield* proofOf(f.replica, point)).toEqual({
                installed: true,
                coveredBy: "Item",
                proof: { reason: "collection", maintainedBy: "snapshot" },
            });
            expect(f.loads("Item")).toBe(1);
            expect(slow.pollUnsafe()).toBeUndefined();

            yield* held.release;
            yield* Fiber.join(slow);
            expect(yield* f.replica.get("Tag", "one")).toEqual({ id: "one", value: 1 });
        })
    )
);

it.effect("stale coverage is served within the bound and revalidated in the background", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture({ refresh: { maxCoverageAgeMs: 1_000, maxStaleAgeMs: 10_000 } });
            yield* f.replica.demand(whole);
            yield* f.replica.demand(point);
            yield* f.replica.syncSubset(whole);
            yield* f.replica.syncSubset(point);
            expect(f.loads()).toBe(1);

            yield* TestClock.adjust(2_000);
            f.setValue(2);
            const held = yield* f.holdLoads();
            // Both resolve from the expired confirmation without waiting for a load.
            yield* f.replica.syncSubset(whole);
            yield* f.replica.syncSubset(point);
            const stale = { stale: true, confirmedAt: 0 };
            expect(yield* proofOf(f.replica, whole)).toMatchObject({ installed: true, proof: stale });
            expect(yield* proofOf(f.replica, point)).toMatchObject({ installed: true, proof: stale });
            expect(yield* f.replica.get("Item", "one")).toEqual({ id: "one", value: 1 });
            expect(yield* hasCoverage(f, whole)).toBe(true);

            // The background pass refreshes the owning collection once; the point
            // demand it covers does not issue its own load.
            yield* held.started;
            yield* f.replica.syncSubset(point);
            yield* held.release;
            yield* settled(f.replica);
            expect(f.loads()).toBe(2);
            expect(yield* f.replica.get("Item", "one")).toEqual({ id: "one", value: 2 });
            expect((yield* proofOf(f.replica, point)).proof?.stale).toBeUndefined();
            expect((yield* proofOf(f.replica, whole)).proof?.stale).toBeUndefined();
        })
    )
);

it.effect("coverage older than the stale bound waits for its reload", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture({ refresh: { maxCoverageAgeMs: 1_000, maxStaleAgeMs: 10_000 } });
            yield* f.replica.demand(whole);
            yield* f.replica.syncSubset(whole);
            yield* TestClock.adjust(10_000);
            f.setValue(3);
            const held = yield* f.holdLoads();
            const read = yield* Effect.forkScoped(f.replica.syncSubset(whole));
            yield* held.started;
            yield* TestClock.adjust(0);
            expect(read.pollUnsafe()).toBeUndefined();
            yield* held.release;
            yield* Fiber.join(read);
            expect(yield* f.replica.get("Item", "one")).toEqual({ id: "one", value: 3 });
            expect((yield* proofOf(f.replica, whole)).proof?.stale).toBeUndefined();
        })
    )
);

const waitsForReload = (f: Effect.Success<ReturnType<typeof fixture>>) =>
    Effect.gen(function* () {
        const held = yield* f.holdLoads();
        const read = yield* Effect.forkScoped(f.replica.syncSubset(whole));
        yield* held.started;
        yield* TestClock.adjust(0);
        expect(read.pollUnsafe()).toBeUndefined();
        yield* held.release;
        yield* Fiber.join(read);
    });

it.effect("with maxStaleAgeMs 0 expired coverage is never served stale", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture({ refresh: { maxCoverageAgeMs: 1_000, maxStaleAgeMs: 0 } });
            yield* f.replica.demand(whole);
            yield* f.replica.syncSubset(whole);
            yield* TestClock.adjust(2_000);
            yield* waitsForReload(f);
        })
    )
);

it.effect("by default expired coverage is served stale for ten coverage ages", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture({ refresh: { maxCoverageAgeMs: 1_000 } });
            yield* f.replica.demand(whole);
            yield* f.replica.syncSubset(whole);
            yield* TestClock.adjust(2_000);
            const held = yield* f.holdLoads();
            yield* f.replica.syncSubset(whole);
            expect(yield* proofOf(f.replica, whole)).toMatchObject({
                proof: { stale: true, confirmedAt: 0 },
            });
            yield* held.started;
            yield* held.release;
            yield* settled(f.replica);
            // Ten coverage ages after the refresh, the read waits again.
            yield* TestClock.adjust(10_000);
            yield* waitsForReload(f);
        })
    )
);

it.effect("a one-shot replica does not serve stale coverage by default", () =>
    Effect.scoped(
        Effect.gen(function* () {
            // Nothing would revalidate it in the background.
            const f = yield* fixture({ refresh: { maxCoverageAgeMs: 1_000 }, startSync: false });
            yield* f.replica.demand(whole);
            yield* f.replica.syncSubset(whole);
            yield* TestClock.adjust(2_000);
            yield* waitsForReload(f);
        })
    )
);

it.effect("a poll tick marks coverage due without hiding it, until the stale bound", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture({ pollIntervalMs: 1_000, refresh: { maxStaleAgeMs: 5_000 } });
            yield* f.replica.demand(whole);
            yield* f.replica.syncSubset(whole);
            const held = yield* f.holdLoads();
            yield* TestClock.adjust(1_000);
            // The tick starts a revalidation that outlasts several poll intervals.
            yield* held.started;
            expect(yield* hasCoverage(f, whole)).toBe(true);
            yield* f.replica.demand(point);
            yield* f.replica.syncSubset(point);
            expect(yield* proofOf(f.replica, point)).toMatchObject({
                installed: true,
                proof: { stale: true, maintainedBy: "poll" },
            });

            yield* TestClock.adjust(4_000);
            expect(yield* hasCoverage(f, whole)).toBe(false);
            const read = yield* Effect.forkScoped(f.replica.syncSubset(point));
            yield* TestClock.adjust(0);
            expect(read.pollUnsafe()).toBeUndefined();

            // Later ticks did not fence the in-flight refresh: it still installs.
            yield* held.release;
            yield* Fiber.join(read);
            expect(yield* hasCoverage(f, whole)).toBe(true);
            expect(f.loads()).toBe(2);
        })
    )
);

it.live("stale admission never installs a snapshot while an action is sending", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture({ refresh: { maxCoverageAgeMs: 100, maxStaleAgeMs: 60_000 } });
            yield* f.replica.demand(whole);
            yield* f.replica.syncSubset(whole);
            expect(f.events).toEqual(["load:Item"]);
            yield* Effect.sleep("150 millis");
            f.events.length = 0;

            const action = yield* f.holdActions;
            yield* f.replica.enqueue({ id: "write-1", name: "write", parameters: {} });
            yield* action.started;
            // Served immediately with the optimistic overlay. The revalidation it requests
            // may fetch, but cannot install until the receipt settles the overlay.
            yield* f.replica.syncSubset(whole).pipe(Effect.timeout("1 second"));
            expect((yield* proofOf(f.replica, whole)).proof?.stale).toBe(true);
            expect(yield* f.replica.get("Item", "one")).toEqual({ id: "one", value: 99 });
            yield* Effect.sleep("50 millis");
            expect(yield* f.replica.confirmed.get("Item", "one")).toEqual({ id: "one", value: 1 });

            yield* action.release;
            yield* f.replica.awaitAction("write-1").pipe(Effect.timeout("1 second"));
            yield* f.replica.syncSubset(whole);
            expect(f.events.indexOf("applied")).toBeGreaterThan(f.events.indexOf("apply"));
            expect(yield* f.replica.confirmed.get("Item", "one")).toEqual({ id: "one", value: 99 });
            expect(yield* f.replica.get("Item", "one")).toEqual({ id: "one", value: 99 });
            expect(yield* f.replica.pending).toEqual([]);
        })
    )
);

it.live("an explicit revalidation during a load refetches before that load completes", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture({ startSync: false, refresh: { maxStaleAgeMs: 60_000 } });
            yield* f.replica.demand(whole);
            yield* f.replica.syncSubset(whole);
            yield* f.replica.markDemandedStale;
            const held = yield* f.holdLoads();
            const refresh = yield* Effect.forkScoped(f.replica.syncOnce);
            yield* held.started;
            // Requested after that fetch began: its rows install as still due, and the
            // same load fetches again.
            yield* f.replica.markDemandedStale;
            f.setValue(2);
            yield* held.release;
            yield* Fiber.join(refresh);
            expect(f.loads()).toBe(3);
            expect((yield* proofOf(f.replica, whole)).proof?.stale).toBeUndefined();
            const { rows } = yield* f.replica.snapshotSubset({ ...whole, query: {} });
            expect(rows.map((row) => (row.value as { value: number }).value)).toEqual([2]);
        })
    )
);

it.live("a cold read is not blocked by a slow refresh of another subset of its type", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture({ startSync: false });
            const ones = { objectType: "Item", query: { where: eq(field("value"), 1) } };
            const twos = { objectType: "Item", query: { where: eq(field("value"), 2) } };
            yield* f.replica.demand(ones);
            yield* f.replica.syncSubset(ones);
            yield* f.replica.markDemandedStale;
            const held = yield* f.holdLoads(true);
            const refresh = yield* Effect.forkScoped(f.replica.syncOnce);
            yield* held.started;
            // Neither subset contains the other, so the new one loads alongside.
            yield* f.replica.demand(twos);
            yield* f.replica.syncSubset(twos).pipe(Effect.timeout("1 second"));
            expect(f.loads()).toBe(3);
            expect(refresh.pollUnsafe()).toBeUndefined();
            yield* held.release;
            yield* Fiber.join(refresh);
        })
    )
);

it.live("an action dispatches and confirms while a refresh is still fetching", () =>
    Effect.scoped(
        Effect.gen(function* () {
            // The read waits for the refresh rather than answering stale.
            const f = yield* fixture({ refresh: { maxStaleAgeMs: 0 } });
            yield* f.replica.demand(whole);
            yield* f.replica.syncSubset(whole);
            yield* f.replica.markDemandedStale;
            const held = yield* f.holdLoads(true);
            const refresh = yield* Effect.forkScoped(f.replica.syncSubset(whole));
            yield* held.started;
            yield* f.replica.enqueue({ id: "write-during-refresh", name: "write", parameters: {} });
            yield* f.replica.awaitAction("write-during-refresh").pipe(Effect.timeout("1 second"));
            expect(f.events).toContain("applied");
            expect(refresh.pollUnsafe()).toBeUndefined();
            yield* held.release;
            yield* Fiber.join(refresh);
            expect(yield* f.replica.get("Item", "one")).toEqual({ id: "one", value: 99 });
        })
    )
);

it.effect("rejects an invalid load concurrency", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const error = yield* Effect.flip(fixture({ maxConcurrentLoads: 0 }));
            expect(error.kind).toBe("InvalidConfiguration");
        })
    )
);

it.effect("rejects a negative stale bound", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const error = yield* Effect.flip(fixture({ refresh: { maxStaleAgeMs: -1 } }));
            expect(error.kind).toBe("InvalidConfiguration");
        })
    )
);

for (const scheduling of [undefined, "serial"] as const)
    it.effect(`a load slower than the poll interval still installs (${scheduling ?? "detached"})`, () =>
        Effect.scoped(
            Effect.gen(function* () {
                let version = 0;
                const tables = yield* Memory.make();
                const replica = yield* makeReplica({
                    namespace: "slow-poll",
                    ir,
                    tables,
                    startSync: true,
                    objectCacheGc: false,
                    ...(scheduling === "serial" ? { scheduling: "serial" as const } : {}),
                    execute: () => Effect.void,
                    backend: makeOntologyBackend({
                        ir,
                        name: "fixture",
                        sourceId: "fixture",
                        supportsIdempotency: false,
                        refresh: () => ({ pollIntervalMs: 1_000 }),
                        queryFunction: () => Effect.void,
                        applyAction: () => Effect.die("unused"),
                        loadSubset: (request) =>
                            Effect.gen(function* () {
                                const subset = yield* compileObjectSubset(ir, request);
                                const seen = ++version;
                                yield* Effect.sleep(1_500);
                                return {
                                    rows: evaluateQuery(
                                        [{ key: "one", value: { id: "one", value: seen } }],
                                        subset.query
                                    ),
                                    complete: true,
                                };
                            }),
                    }),
                });
                yield* replica.demand(whole);
                const read = yield* Effect.forkScoped(replica.syncSubset(whole));
                for (let tick = 0; tick < 20 && !read.pollUnsafe(); tick++) yield* TestClock.adjust(500);
                // Every fetch is invalidated by a poll tick before it lands; the read still
                // returns, and the rows installed are the newest fetched.
                expect(read.pollUnsafe()).toBeDefined();
                yield* Fiber.join(read);
                const { rows } = yield* replica.snapshotSubset({ ...whole, query: {} });
                expect(rows).toHaveLength(1);
            })
        )
    );

it.effect("a poll tick marks only its own demand's coverage due", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture({
                startSync: false,
                pollIntervalMs: 1_000,
                refresh: { maxStaleAgeMs: 10_000 },
            });
            const ones = { objectType: "Item", query: { where: eq(field("value"), 1) } };
            const twos = { objectType: "Item", query: { where: eq(field("value"), 2) } };
            const staleOf = (value: number) =>
                Effect.map(
                    f.replica.status,
                    (status) =>
                        status.demands.find((demand) =>
                            JSON.stringify(demand.query).includes(`"value":${value}`)
                        )?.coverageProof?.stale
                );
            yield* f.replica.demand(ones);
            yield* f.replica.syncSubset(ones);
            yield* TestClock.adjust(500);
            yield* f.replica.demand(twos);
            yield* f.replica.syncSubset(twos);
            // Only `ones` has polled since it loaded.
            yield* TestClock.adjust(600);
            yield* f.replica.syncSubset(ones);
            yield* f.replica.syncSubset(twos);
            expect(yield* staleOf(1)).toBe(true);
            expect(yield* staleOf(2)).toBeUndefined();
        })
    )
);

it.live("a read's fetch is not queued behind background refreshes", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture({ startSync: false, maxConcurrentLoads: 2 });
            const items = [1, 2, 3].map((value) => ({
                objectType: "Item",
                query: { where: eq(field("value"), value) },
            }));
            for (const subset of items) {
                yield* f.replica.demand(subset);
                yield* f.replica.syncSubset(subset);
            }
            yield* f.replica.invalidate(["Item"]);
            const held = yield* f.holdLoads();
            f.events.length = 0;
            // A checkpoint refreshes all three; no reader is waiting for them.
            const refresh = yield* Effect.forkScoped(f.replica.syncOnce);
            yield* held.started;
            yield* Effect.sleep("20 millis");
            yield* f.replica.demand(tags);
            const read = yield* Effect.forkScoped(f.replica.syncSubset(tags));
            yield* Effect.sleep("50 millis");
            // One background fetch runs; the cold read takes the slot left for reads.
            expect(f.events).toEqual(["load:Item", "load:Tag"]);
            yield* held.release;
            yield* Fiber.join(read);
            yield* Fiber.join(refresh);
            expect(f.loads("Item")).toBe(3);
        })
    )
);
