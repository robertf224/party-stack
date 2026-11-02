import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { eq, field, evaluateQuery } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Cause, Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { makeReplica, makeCachedProxy } from "./testing.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    actionTypes: [{ name: "save", displayName: "Save", parameters: [], logic: [] }],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "count", displayName: "Count", type: o.integer({}) },
            ],
        },
    ],
};

const quietBackend: OntologyBackendService = {
    name: "cache-lifetime",
    sourceId: "cache-lifetime",
    supportsIdempotency: false,
    loadSubset: () => Effect.succeed({ rows: [], complete: true }),
    applyAction: () => Effect.die("Unexpected action"),
    queryFunction: () => Effect.void,
    refresh: () => ({ pollIntervalMs: false }),
};
const subsetFor = (key: string) => ({ objectType: "Item", query: { where: eq(field("id"), key) } });

test("cached demand renews its idle TTL and evicts the oldest idle lease at capacity", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const replica = yield* makeReplica({
                    namespace: "idle-cache",
                    demand: { idleRetentionMs: 60_000, maxSubsets: 2 },
                    ir,
                    backend: quietBackend,
                    tables: yield* Memory.make(),
                    startSync: false,
                    objectCacheGc: false,
                    execute: () => Effect.void,
                });
                const proxy = yield* makeCachedProxy({ replica, backend: quietBackend });
                yield* proxy.loadSubset(subsetFor("a"));
                yield* TestClock.adjust(10_000);
                yield* proxy.loadSubset(subsetFor("b"));
                yield* TestClock.adjust(10_000);
                yield* proxy.loadSubset(subsetFor("a"));
                yield* TestClock.adjust(10_000);
                yield* proxy.loadSubset(subsetFor("c"));
                expect((yield* replica.status).demands.map((demand) => demand.query)).toEqual([
                    subsetFor("a").query,
                    subsetFor("c").query,
                ]);
                // A's original deadline was 60s. Reuse at 20s renewed it to 80s.
                yield* TestClock.adjust(30_000);
                expect((yield* replica.status).demands).toHaveLength(2);
                yield* TestClock.adjust(20_000);
                expect((yield* replica.status).demands.map((demand) => demand.query)).toEqual([
                    subsetFor("c").query,
                ]);
                yield* TestClock.adjust(10_000);
                expect((yield* replica.status).demands).toEqual([]);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});

test("cached demand never evicts a subset while its request is reading", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const replica = yield* makeReplica({
                    namespace: "active-cache",
                    demand: { idleRetentionMs: 60_000, maxSubsets: 1 },
                    ir,
                    backend: quietBackend,
                    tables: yield* Memory.make(),
                    startSync: false,
                    objectCacheGc: false,
                    execute: () => Effect.void,
                });
                const reading = yield* Deferred.make<void>();
                const release = yield* Deferred.make<void>();
                const proxy = yield* makeCachedProxy({
                    replica: {
                        ...replica,
                        snapshotSubset: (subset, confirmed) =>
                            Deferred.succeed(reading, undefined).pipe(
                                Effect.andThen(Deferred.await(release)),
                                Effect.andThen(replica.snapshotSubset(subset, confirmed))
                            ),
                    },
                    backend: quietBackend,
                });
                const request = yield* Effect.forkChild(proxy.loadSubset(subsetFor("a")));
                yield* Deferred.await(reading);
                expect(yield* Effect.result(proxy.loadSubset(subsetFor("b")))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "RateLimited" },
                });
                expect((yield* replica.status).demands.map((demand) => demand.query)).toEqual([
                    subsetFor("a").query,
                ]);
                yield* Deferred.succeed(release, undefined);
                yield* Fiber.join(request);
                yield* proxy.loadSubset(subsetFor("b"));
                expect((yield* replica.status).demands.map((demand) => demand.query)).toEqual([
                    subsetFor("b").query,
                ]);
            })
        )
    );
});
test("cached proxy shares demand, forwards writes, and never enqueues them locally", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* makeOwnedBackend({
                    namespace: "authority",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: {
                        save: (tx) =>
                            Effect.gen(function* () {
                                const previous = yield* tx.get("Item", "one");
                                yield* tx.put("Item", { id: "one", count: Number(previous?.count ?? 0) + 1 });
                            }),
                    },
                });
                let loads = 0;
                const backend = {
                    ...owned,
                    changes: undefined,
                    refresh: () => ({ pollIntervalMs: false as const }),
                    loadSubset: (subset: Parameters<typeof owned.loadSubset>[0]) =>
                        Effect.sync(() => loads++).pipe(Effect.andThen(owned.loadSubset(subset))),
                };
                const replica = yield* makeReplica({
                    namespace: "cache",
                    demand: { idleRetentionMs: 60_000, maxSubsets: 1 },
                    ir,
                    backend,
                    tables: yield* Memory.make(),
                    startSync: false,
                    execute: () => Effect.void,
                });
                const proxy = yield* makeCachedProxy({
                    replica,
                    backend,
                });
                const subset = { objectType: "Item" };
                yield* proxy.loadSubset(subset);
                yield* proxy.loadSubset(subset);
                expect(loads).toBe(1);
                expect((yield* replica.status).demands).toHaveLength(1);
                const quietProxy = yield* makeCachedProxy({
                    replica,
                    backend: {
                        ...backend,
                        applyAction: (action) =>
                            Effect.succeed({
                                operationId: action.id,
                                outcome: "committed",
                                affected: [{ objectType: "Telemetry" }],
                                affectedComplete: true,
                            }),
                    },
                });
                yield* quietProxy.applyAction({ id: "event", name: "recordEvent", parameters: {} });
                yield* proxy.loadSubset(subset);
                expect(loads).toBe(1);
                const receipt = yield* proxy.applyAction({ id: "one", name: "save", parameters: {} });
                expect(receipt.outcome).toBe("committed");
                expect(yield* replica.pending).toEqual([]);
                expect((yield* proxy.loadSubset(subset)).rows[0]?.value.count).toBe(1);
                expect(yield* replica.pending).toEqual([]);
            })
        )
    );
});

test("cached proxy never promotes an incomplete source snapshot to complete coverage", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = {
                    name: "incomplete",
                    sourceId: "incomplete",
                    supportsIdempotency: false,
                    loadSubset: () =>
                        Effect.succeed({
                            rows: [{ key: "one", value: { id: "one", count: 1 } }],
                            complete: false,
                        }),
                    applyAction: () => Effect.die("unused"),
                    queryFunction: () => Effect.void,
                };
                const replica = yield* makeReplica({
                    namespace: "partial",
                    ir,
                    backend,
                    tables: yield* Memory.make(),
                    execute: () => Effect.void,
                    startSync: false,
                });
                const proxy = yield* makeCachedProxy({ replica, backend });
                const snapshot = yield* proxy.loadSubset({ objectType: "Item" });
                expect(snapshot.complete).toBe(false);
                expect(snapshot.rows).toHaveLength(1);
            })
        )
    );
});

test.each(["unknown", "rejected", "interrupted"] as const)(
    "opt-in polling refreshes after a %s outcome without proxy write recovery",
    async (outcome) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    let count = 0,
                        reads = 0,
                        writes = 0;
                    const refreshed = yield* Deferred.make<void>();
                    const backend: OntologyBackendService = {
                        ...quietBackend,
                        refresh: () => ({ pollIntervalMs: undefined }),
                        loadSubset: () =>
                            Effect.gen(function* () {
                                reads++;
                                if (reads > 1) yield* Deferred.succeed(refreshed, undefined);
                                return {
                                    rows: [{ key: "one", value: { id: "one", count } }],
                                    complete: true,
                                };
                            }),
                        applyAction: () =>
                            Effect.gen(function* () {
                                writes++;
                                if (outcome !== "rejected") count++;
                                if (outcome === "interrupted") return yield* Effect.interrupt;
                                return yield* new BackendError({
                                    operation: "applyAction",
                                    kind: outcome === "rejected" ? "ValidationFailed" : "Unavailable",
                                    message: "A write failed.",
                                    retryable: false,
                                    actionOutcome: outcome === "rejected" ? "not-committed" : "unknown",
                                });
                            }),
                    };
                    const replica = yield* makeReplica({
                        namespace: "proxy-outcome",
                        ir,
                        tables: yield* Memory.make(),
                        backend,
                        execute: () => Effect.void,
                        objectCacheGc: false,
                        demand: { idleRetentionMs: 60_000, refresh: { pollIntervalMs: 5_000 } },
                    });
                    const proxy = yield* makeCachedProxy({ replica, backend });
                    expect((yield* proxy.loadSubset({ objectType: "Item" })).rows[0]?.value.count).toBe(0);
                    const action = proxy.applyAction({ id: "one", name: "save", parameters: {} });
                    if (outcome === "interrupted") {
                        const exit = yield* Fiber.await(yield* Effect.forkChild(action));
                        expect(exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
                    } else {
                        expect(yield* Effect.result(action)).toMatchObject({
                            _tag: "Failure",
                            failure: { actionOutcome: outcome === "rejected" ? "not-committed" : "unknown" },
                        });
                    }
                    // A failed call promises no read-after-write barrier or eager repair.
                    expect((yield* proxy.loadSubset({ objectType: "Item" })).rows[0]?.value.count).toBe(0);
                    expect(reads).toBe(1);
                    yield* TestClock.adjust(4_999);
                    expect(reads).toBe(1);
                    yield* TestClock.adjust(1);
                    yield* Deferred.await(refreshed);
                    expect((yield* proxy.loadSubset({ objectType: "Item" })).rows[0]?.value.count).toBe(
                        outcome === "rejected" ? 0 : 1
                    );
                    expect(reads).toBe(2);
                    expect(writes).toBe(1);
                    expect(yield* replica.pending).toEqual([]);
                })
            ).pipe(Effect.provide(TestClock.layer()))
        );
    }
);

const targetCases = [
    {
        name: "complete key targets",
        fields: { affected: [{ objectType: "Item", keys: ["one"] }] },
        changed: ["Item"],
        refresh: ["Item", "Item"],
    },
    {
        name: "whole-type targets",
        fields: { affected: [{ objectType: "Item" }] },
        changed: ["Item"],
        refresh: ["Item", "Item"],
    },
    {
        name: "missing targets",
        fields: {},
        changed: ["Item", "Other"],
        refresh: ["Item", "Item", "Other", "Other"],
    },
    {
        name: "incomplete targets",
        fields: { affected: [{ objectType: "Item", keys: ["one"] }], affectedComplete: false },
        changed: ["Item", "Other"],
        refresh: ["Item", "Item", "Other", "Other"],
    },
    { name: "explicitly empty targets", fields: { affected: [] }, changed: [], refresh: [] },
];
test.each(targetCases)(
    "cached proxy invalidation uses $name conservatively",
    async ({ fields, changed, refresh }) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const definition = {
                        ...ir,
                        objectTypes: [...ir.objectTypes, { ...ir.objectTypes[0]!, name: "Other" }],
                    };
                    const counts = new Map<string, number>();
                    const reads: string[] = [];
                    const backend: OntologyBackendService = {
                        ...quietBackend,
                        loadSubset: (subset) =>
                            Effect.sync(() => {
                                reads.push(subset.objectType);
                                return {
                                    complete: true,
                                    rows: evaluateQuery(
                                        ["one", "two"].map((id) => ({
                                            key: id,
                                            value: {
                                                id,
                                                count:
                                                    id === "one" ? (counts.get(subset.objectType) ?? 0) : 0,
                                            },
                                        })),
                                        subset.query
                                    ),
                                };
                            }),
                        applyAction: (request) =>
                            Effect.sync(() => {
                                for (const type of changed) counts.set(type, 1);
                                return { operationId: request.id, outcome: "committed" as const, ...fields };
                            }),
                    };
                    const replica = yield* makeReplica({
                        namespace: "proxy-targets",
                        ir: definition,
                        backend,
                        tables: yield* Memory.make(),
                        execute: () => Effect.void,
                        startSync: false,
                        demand: { idleRetentionMs: 60_000, refresh: { pollIntervalMs: 5_000 } },
                    });
                    const proxy = yield* makeCachedProxy({ replica, backend });
                    const subsets = ["Item", "Other"].flatMap((objectType) =>
                        ["one", "two"].map((id) => ({
                            ...subsetFor(id),
                            objectType,
                        }))
                    );
                    for (const subset of subsets) yield* proxy.loadSubset(subset);
                    reads.length = 0;
                    yield* proxy.applyAction({ id: "one", name: "save", parameters: {} });
                    for (const subset of subsets) {
                        const row = (yield* proxy.loadSubset(subset)).rows[0]!;
                        expect(row.value.count).toBe(
                            row.key === "one" && changed.includes(subset.objectType) ? 1 : 0
                        );
                    }
                    expect(reads).toEqual(refresh);
                    expect(yield* replica.pending).toEqual([]);
                })
            )
        );
    }
);

test("cache invalidation failures preserve the receipt, block stale reads and repair without resubmission", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let count = 0,
                    writes = 0,
                    failures = 2;
                const backend: OntologyBackendService = {
                    ...quietBackend,
                    loadSubset: () =>
                        Effect.succeed({
                            rows: [{ key: "one", value: { id: "one", count } }],
                            complete: true,
                        }),
                    applyAction: (request) =>
                        Effect.sync(() => {
                            writes++;
                            count++;
                            return {
                                operationId: request.id,
                                outcome: "committed" as const,
                                affected: [{ objectType: "Item", keys: ["one"] }],
                            };
                        }),
                };
                const replica = yield* makeReplica({
                    namespace: "proxy-repair",
                    ir,
                    backend,
                    tables: yield* Memory.make(),
                    execute: () => Effect.void,
                    startSync: false,
                    demand: { idleRetentionMs: 60_000, refresh: { pollIntervalMs: 5_000 } },
                });
                const proxy = yield* makeCachedProxy({
                    replica: {
                        ...replica,
                        invalidate: (types) =>
                            Effect.suspend(() =>
                                failures-- > 0
                                    ? Effect.fail(
                                          new BackendError({
                                              operation: "storage",
                                              kind: "Unavailable",
                                              retryable: true,
                                              message: "Cache storage unavailable.",
                                          })
                                      )
                                    : replica.invalidate(types)
                            ),
                    },
                    backend,
                });
                yield* proxy.loadSubset({ objectType: "Item" });
                expect(yield* proxy.applyAction({ id: "one", name: "save", parameters: {} })).toMatchObject({
                    outcome: "committed",
                });
                expect(yield* Effect.result(proxy.loadSubset({ objectType: "Item" }))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "Unavailable" },
                });
                expect((yield* proxy.loadSubset({ objectType: "Item" })).rows[0]?.value.count).toBe(1);
                expect(writes).toBe(1);
                expect(yield* replica.pending).toEqual([]);
            })
        )
    );
});
