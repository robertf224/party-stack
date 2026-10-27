import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { eq, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { makeReplica, makeCachedProxy } from "./index.js";
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
    invoke: () => Effect.die("Unexpected action"),
    queryFunction: () => Effect.void,
    pollIntervalMs: () => false,
};
const subsetFor = (key: string) => ({ objectType: "Item", query: { where: eq(field("id"), key) } });

test("cached demand renews its idle TTL and evicts the oldest idle lease at capacity", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const replica = yield* makeReplica({
                    namespace: "idle-cache",
                    ir,
                    backend: quietBackend,
                    tables: yield* Memory.make(),
                    startSync: false,
                    gc: false,
                    execute: () => Effect.void,
                });
                const proxy = yield* makeCachedProxy({ replica, backend: quietBackend, maxSubsets: 2 });
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
                    ir,
                    backend: quietBackend,
                    tables: yield* Memory.make(),
                    startSync: false,
                    gc: false,
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
                    maxSubsets: 1,
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
                    pollIntervalMs: () => false as const,
                    loadSubset: (subset: Parameters<typeof owned.loadSubset>[0]) =>
                        Effect.sync(() => loads++).pipe(Effect.andThen(owned.loadSubset(subset))),
                };
                const replica = yield* makeReplica({
                    namespace: "cache",
                    ir,
                    backend,
                    tables: yield* Memory.make(),
                    startSync: false,
                    execute: () => Effect.void,
                });
                const proxy = yield* makeCachedProxy({
                    replica,
                    backend,
                    idleDemandMs: 60_000,
                    maxSubsets: 1,
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
                        invoke: (action) =>
                            Effect.succeed({
                                invocationId: action.id,
                                outcome: "committed",
                                affected: [{ objectType: "Telemetry" }],
                                affectedComplete: true,
                            }),
                    },
                });
                yield* quietProxy.invoke({ id: "event", name: "recordEvent", parameters: {} });
                yield* proxy.loadSubset(subset);
                expect(loads).toBe(1);
                const receipt = yield* proxy.invoke({ id: "one", name: "save", parameters: {} });
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
                    invoke: () => Effect.die("unused"),
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
