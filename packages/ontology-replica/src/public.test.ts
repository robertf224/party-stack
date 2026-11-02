import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as q from "@party-stack/ontology-spec/query";
import { evaluateQuery } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { makeNetworkConnectivity, MemoryRuntime, RuntimePartition } from "@party-stack/runtime";
import { Effect, Exit, Scope, Layer } from "effect";
import { expect, test } from "vitest";
import { makeReplica, Replica, ReplicaUpstream } from "./index.js";
import type { BackendSubset } from "@party-stack/ontology-backend";
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
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "count", displayName: "Count", type: o.integer({}) },
            ],
        },
    ],
    actionTypes: [
        {
            name: "create",
            displayName: "Create",
            parameters: [
                {
                    name: "id",
                    displayName: "Id",
                    type: o.optional({ type: o.string({}) }),
                    defaultValue: o.Expression.uuid({}),
                },
                { name: "count", displayName: "Count", type: o.integer({}) },
            ],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "Item",
                    values: [
                        { property: ["id"], value: q.input("id") },
                        { property: ["count"], value: q.input("count") },
                    ],
                }),
            ],
        },
    ],
};
test("logical demand waits for its snapshot, releases its scope and rejects unsupported plans without broadening", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const calls: BackendSubset[] = [];
                const replica = yield* makeReplica({
                    namespace: "public-demand",
                    ir,
                    tables: yield* Memory.make(),
                    startSync: false,
                    backend: {
                        name: "fixture",
                        sourceId: "fixture",
                        supportsIdempotency: false,
                        applyAction: () => Effect.die("A read cannot submit actions"),
                        queryFunction: () => Effect.void,
                        pollIntervalMs: () => false,
                        loadSubset: (subset) =>
                            Effect.sync(() => {
                                calls.push(subset);
                                return {
                                    complete: true,
                                    rows: evaluateQuery(
                                        [1, 2, 3].map((count) => ({
                                            key: String(count),
                                            value: { id: String(count), count },
                                        })),
                                        subset.query
                                    ),
                                };
                            }),
                    },
                });
                const consumer = yield* Scope.make();
                yield* Scope.provide(
                    replica.demand.acquire({
                        from: { source: { objectType: "Item" }, binding: "item" },
                        where: q.gte(q.field("item", "count"), q.literal(2)),
                        orderBy: [{ expression: q.field("item", "count"), direction: "desc" }],
                        page: { limit: 1 },
                    }),
                    consumer
                );
                expect(calls).toHaveLength(1);
                expect((yield* replica.get("Item", "3"))?.count).toBe(3);
                expect((yield* replica.status).demands).toHaveLength(1);
                yield* Scope.close(consumer, Exit.void);
                expect((yield* replica.status).demands).toEqual([]);
                const before = calls.length;
                const unsupported = yield* Effect.result(
                    replica.demand.acquire({
                        from: { source: { objectType: "Item" }, binding: "item" },
                        where: q.eq(q.add(q.field("item", "count"), q.literal(1)), q.literal(3)),
                    })
                );
                expect(unsupported).toMatchObject({ _tag: "Failure", failure: { kind: "NotImplemented" } });
                expect(calls).toHaveLength(before);
                const malformed = yield* Effect.result(replica.demand.acquire({} as never));
                expect(malformed).toMatchObject({ _tag: "Failure", failure: { kind: "InvalidRequest" } });
            })
        )
    );
});

test.each([true, false])(
    "native replay freezes defaults offline and confirms without a replay hook (optimistic=%s)",
    async (optimistic) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const connectivity = yield* makeNetworkConnectivity(false);
                    const remote = new Map<string | number, Record<string, unknown>>();
                    let loads = 0,
                        submissions = 0;
                    const replica = yield* makeReplica({
                        namespace: "native-replay",
                        ir,
                        tables: yield* Memory.make(),
                        connectivity,
                        startSync: false,
                        backend: {
                            name: "fixture",
                            sourceId: "fixture",
                            supportsIdempotency: true,
                            queryFunction: () => Effect.void,
                            pollIntervalMs: () => false,
                            loadSubset: (subset) =>
                                Effect.sync(() => {
                                    loads++;
                                    return {
                                        complete: true,
                                        rows: evaluateQuery(
                                            [...remote].map(([key, value]) => ({ key, value })),
                                            subset.query
                                        ),
                                    };
                                }),
                            applyAction: (request) =>
                                Effect.sync(() => {
                                    submissions++;
                                    const id = request.parameters.id as string;
                                    remote.set(id, { id, count: request.parameters.count });
                                    return {
                                        operationId: request.id,
                                        outcome: "committed" as const,
                                        affected: [{ objectType: "Item", keys: [id] }],
                                    };
                                }),
                        },
                    });
                    yield* replica.demand.acquire({
                        from: { source: { objectType: "Item" }, binding: "item" },
                    });
                    const entry = yield* replica.enqueue(
                        { id: "create-1", name: "create", parameters: { count: 7 } },
                        { optimistic }
                    );
                    const id = entry.invocation.parameters.id as string;
                    expect(id).toMatch(/^[0-9a-f-]{36}$/);
                    expect((yield* replica.get("Item", id))?.count).toBe(optimistic ? 7 : undefined);
                    expect(yield* replica.confirmed.get("Item", id)).toBeUndefined();
                    expect([loads, submissions]).toEqual([0, 0]);
                    yield* connectivity.set(true);
                    yield* replica.syncOnce;
                    expect(submissions).toBe(1);
                    expect(yield* replica.pending).toEqual([]);
                    expect((yield* replica.confirmed.get("Item", id))?.count).toBe(7);
                    expect((yield* replica.awaitAction("create-1"))?.operationId).toBe("create-1");
                })
            )
        );
    }
);

test("the replica Layer acquires its platform resources from one Runtime bundle", async () => {
    const app = Replica.layer({ ir, startSync: false }).pipe(
        Layer.provide(
            Layer.succeed(ReplicaUpstream)({
                kind: "committed",
                backend: {
                    name: "fixture",
                    sourceId: "fixture",
                    supportsIdempotency: true,
                    queryFunction: () => Effect.void,
                    applyAction: () => Effect.die("Unexpected action"),
                    pollIntervalMs: () => false,
                    loadSubset: () =>
                        Effect.succeed({
                            complete: true,
                            rows: [{ key: "one", value: { id: "one", count: 1 } }],
                        }),
                },
            })
        ),
        Layer.provide(MemoryRuntime.layer),
        Layer.provide(Layer.succeed(RuntimePartition)({ owner: "test", namespace: "layer" }))
    );
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const replica = yield* Replica;
                yield* replica.demand.acquire({ from: { source: { objectType: "Item" }, binding: "item" } });
                expect((yield* replica.get("Item", "one"))?.count).toBe(1);
            })
        ).pipe(Effect.provide(app))
    );
});
