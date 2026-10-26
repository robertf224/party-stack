import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { eq, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect, Scope, Exit, Result } from "effect";
import { expect, test } from "vitest";
import { makeReplica, type ReplicaService } from "./index.js";
import type { ActionInvocation, OntologyBackendService } from "@party-stack/ontology-backend";
import type { OwnedTransaction } from "@party-stack/ontology-backend/owned";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Counter",
            displayName: "Counter",
            pluralDisplayName: "Counters",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "count", displayName: "Count", type: o.integer({}) },
            ],
        },
    ],
    actionTypes: ["increment", "reject"].map((name) => ({
        name,
        displayName: name,
        parameters: [],
        logic: [],
    })),
};
const execute = (tx: OwnedTransaction, action: ActionInvocation) =>
    Effect.gen(function* () {
        const previous = yield* tx.get("Counter", "shared");
        yield* tx.put("Counter", { id: "shared", count: Number(previous?.count ?? 0) + 1 });
        expect((yield* tx.get("Counter", "shared"))?.count).toBe(Number(previous?.count ?? 0) + 1);
        if (action.name === "reject")
            return yield* new BackendError({
                operation: "test",
                kind: "ValidationFailed",
                message: "Expected",
                retryable: false,
            });
    });

test("offline enqueue, restart, ordered rebase and reconnect never require network replay reads", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const server = yield* Memory.make();
                const local = yield* Memory.make();
                const backend = yield* makeOwnedBackend({
                    namespace: "server",
                    ir,
                    tables: server,
                    mutators: { increment: execute },
                });
                let online = true;
                let requests = 0;
                const remote: OntologyBackendService = {
                    ...backend,
                    loadSubset: (subset) =>
                        Effect.suspend(() => {
                            requests++;
                            if (!online) throw new Error("Replay attempted a network load");
                            return backend.loadSubset(subset);
                        }),
                    invoke: (action) =>
                        Effect.suspend(() => {
                            requests++;
                            if (!online) throw new Error("Replay attempted dispatch offline");
                            return backend.invoke(action);
                        }),
                    changes: {
                        pull: (query) =>
                            Effect.suspend(() => {
                                requests++;
                                if (!online) throw new Error("Replay attempted a network pull");
                                return backend.changes!.pull(query);
                            }),
                    },
                };
                const settings = {
                    namespace: "local",
                    ir,
                    tables: local,
                    backend: remote,
                    execute,
                    startSync: false,
                    online: Effect.sync(() => online),
                };
                yield* backend.invoke({ id: "seed", name: "increment", parameters: {} });
                const firstScope = yield* Scope.make();
                const first = yield* Scope.provide(makeReplica(settings), firstScope);
                yield* first.syncOnce;
                expect((yield* first.get("Counter", "shared"))?.count).toBe(1);
                online = false;
                const before = requests;
                yield* first.enqueue({ id: "offline-1", name: "increment", parameters: {} });
                yield* first.enqueue({ id: "offline-2", name: "increment", parameters: {} });
                expect((yield* first.get("Counter", "shared"))?.count).toBe(3);
                expect((yield* first.confirmed.get("Counter", "shared"))?.count).toBe(1);
                yield* Scope.close(firstScope, Exit.void);
                expect(Result.isFailure(yield* Effect.result(first.pending))).toBe(true);
                expect(Result.isFailure(yield* Effect.result(first.remove("offline-1")))).toBe(true);
                const reopened = yield* makeReplica(settings);
                expect((yield* reopened.pending).length).toBe(2);
                expect((yield* reopened.get("Counter", "shared"))?.count).toBe(3);
                yield* reopened.syncOnce;
                expect(requests).toBe(before);
                online = true;
                yield* backend.invoke({ id: "another-client", name: "increment", parameters: {} });
                yield* reopened.syncOnce;
                expect(yield* reopened.pending).toEqual([]);
                expect((yield* reopened.confirmed.get("Counter", "shared"))?.count).toBe(4);
                expect((yield* backend.loadSubset({ objectType: "Counter" })).rows[0]?.value.count).toBe(4);
            })
        )
    );
});

test("rejected replay is atomic and leaves earlier pending projections intact", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const backend = yield* makeOwnedBackend({
                    namespace: "server",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: { increment: execute },
                });
                const replica = yield* makeReplica({
                    namespace: "local",
                    ir,
                    tables,
                    backend,
                    execute,
                    startSync: false,
                });
                yield* replica.enqueue({ id: "valid", name: "increment", parameters: {} });
                const result = yield* Effect.result(
                    replica.enqueue({ id: "invalid", name: "reject", parameters: {} })
                );
                expect(Result.isFailure(result)).toBe(true);
                expect(yield* replica.pending).toHaveLength(1);
                expect((yield* replica.get("Counter", "shared"))?.count).toBe(1);
            })
        )
    );
});

test("ambiguous non-deduplicated actions survive restart without automatic duplicate dispatch", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const owned = yield* makeOwnedBackend({
                    namespace: "server",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: { increment: execute },
                });
                let dispatches = 0;
                const backend: OntologyBackendService = {
                    ...owned,
                    supportsIdempotency: false,
                    changes: undefined,
                    invoke: () =>
                        Effect.gen(function* () {
                            dispatches++;
                            return yield* new BackendError({
                                operation: "invoke",
                                kind: "Unavailable",
                                message: "Response lost",
                                retryable: true,
                            });
                        }),
                };
                const options = { namespace: "local", ir, tables, backend, execute, startSync: false };
                const first = yield* makeReplica(options);
                yield* first.enqueue({ id: "ambiguous", name: "increment", parameters: {} });
                expect(Result.isFailure(yield* Effect.result(first.syncOnce))).toBe(true);
                expect((yield* first.pending)[0]?.state).toBe("uncertain");
                const reopened = yield* makeReplica(options);
                yield* reopened.syncOnce;
                expect(dispatches).toBe(1);
                expect(Result.isFailure(yield* Effect.result(reopened.retry("ambiguous")))).toBe(true);
                expect(Result.isFailure(yield* Effect.result(reopened.remove("ambiguous")))).toBe(true);
            })
        )
    );
});

test("bounded GC advances past pinned candidates and honors persisted reader leases from another context", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const backend = yield* makeOwnedBackend({
                    namespace: "gc-server",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: {
                        increment: (tx, invocation) => tx.put("Counter", { id: invocation.id, count: 1 }),
                    },
                });
                yield* backend.invoke({ id: "first", name: "increment", parameters: {} });
                yield* backend.invoke({ id: "second", name: "increment", parameters: {} });
                const options = { namespace: "gc-local", ir, tables, backend, execute, startSync: false };
                const first = yield* makeReplica(options);
                yield* first.syncOnce;
                yield* first.pin("Counter", "first", true);
                expect(yield* first.collectGarbage({ limit: 1, olderThanMs: 0 })).toBe(0);
                expect(yield* first.collectGarbage({ limit: 1, olderThanMs: 0 })).toBe(1);
                expect(yield* first.get("Counter", "second")).toBeUndefined();
                expect(yield* first.get("Counter", "first")).toBeDefined();
                const second = yield* makeReplica(options);
                const readerScope = yield* Scope.make();
                yield* Scope.provide(second.retainLocal("Counter"), readerScope);
                yield* first.pin("Counter", "first", false);
                expect(yield* first.collectGarbage({ limit: 10, olderThanMs: 0 })).toBe(0);
                expect(yield* first.collectGarbage({ limit: 10, olderThanMs: 0 })).toBe(0);
                yield* Scope.close(readerScope, Exit.void);
                expect(yield* first.collectGarbage({ limit: 10, olderThanMs: 0 })).toBe(1);
                expect(yield* first.get("Counter", "first")).toBeUndefined();
            })
        )
    );
});

test("historical journal pages cannot regress a newer coordinated subset snapshot", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const server = yield* makeOwnedBackend({
                    namespace: "snapshot-server",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: {},
                });
                let catchingUp = false;
                const observed: unknown[] = [];
                let replica: ReplicaService;
                const backend: OntologyBackendService = {
                    ...server,
                    loadSubset: () =>
                        Effect.succeed({
                            rows: [{ key: "shared", value: { id: "shared", count: 100 } }],
                            complete: true,
                            cursor: "100",
                        }),
                    changes: {
                        pull: (request) =>
                            Effect.gen(function* () {
                                if (!catchingUp) return { commits: [], cursor: "0", hasMore: false };
                                if (request.cursor === "0")
                                    return {
                                        commits: [
                                            {
                                                cursor: "1",
                                                changes: [
                                                    {
                                                        kind: "put" as const,
                                                        objectType: "Counter",
                                                        key: "shared",
                                                        value: { id: "shared", count: 1 },
                                                    },
                                                ],
                                            },
                                        ],
                                        cursor: "1",
                                        hasMore: true,
                                    };
                                observed.push((yield* replica.get("Counter", "shared"))?.count);
                                return {
                                    commits: [
                                        {
                                            cursor: "100",
                                            changes: [
                                                {
                                                    kind: "put" as const,
                                                    objectType: "Counter",
                                                    key: "shared",
                                                    value: { id: "shared", count: 100 },
                                                },
                                            ],
                                        },
                                    ],
                                    cursor: "100",
                                    hasMore: false,
                                };
                            }),
                    },
                };
                replica = yield* makeReplica({
                    namespace: "snapshot-local",
                    ir,
                    tables: yield* Memory.make(),
                    backend,
                    execute,
                    startSync: false,
                });
                yield* replica.demand({ objectType: "Counter" });
                yield* replica.syncOnce;
                expect((yield* replica.get("Counter", "shared"))?.count).toBe(100);
                catchingUp = true;
                yield* replica.syncOnce;
                expect(observed).toEqual([100]);
                expect((yield* replica.get("Counter", "shared"))?.count).toBe(100);
            })
        )
    );
});

test("a deduplicated receipt already behind the local journal head settles without replaying twice", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeOwnedBackend({
                    namespace: "old-receipt-server",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: { increment: execute },
                });
                const invocation = {
                    id: "already-committed",
                    name: "increment",
                    parameters: {},
                    replay: { now: "2026-10-21T00:00:00Z", seed: "already-committed" },
                };
                yield* backend.invoke(invocation);
                yield* backend.invoke({ ...invocation, id: "later" });
                const replica = yield* makeReplica({
                    namespace: "old-receipt-local",
                    ir,
                    tables: yield* Memory.make(),
                    backend,
                    execute,
                    startSync: false,
                });
                yield* replica.syncOnce;
                expect((yield* replica.confirmed.get("Counter", "shared"))?.count).toBe(2);
                yield* replica.enqueue(invocation);
                expect((yield* replica.get("Counter", "shared"))?.count).toBe(3);
                yield* replica.syncOnce;
                expect(yield* replica.pending).toEqual([]);
                expect((yield* replica.receipt(invocation.id))?.outcome).toBe("committed");
                expect((yield* replica.get("Counter", "shared"))?.count).toBe(2);
                expect((yield* backend.loadSubset({ objectType: "Counter" })).rows[0]?.value.count).toBe(2);
            })
        )
    );
});

test("reordered nested invocation fields retain the same durable identity", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const replica = yield* makeReplica({
                    namespace: "canonical-local",
                    ir,
                    tables: yield* Memory.make(),
                    backend: yield* makeOwnedBackend({
                        namespace: "canonical-server",
                        ir,
                        tables: yield* Memory.make(),
                        mutators: {},
                    }),
                    execute,
                    startSync: false,
                });
                yield* replica.enqueue({
                    id: "same",
                    name: "increment",
                    parameters: { a: 0, nested: { x: 1, y: 2 } },
                });
                yield* replica.enqueue({
                    parameters: { nested: { y: 2, x: 1 }, a: 0 },
                    name: "increment",
                    id: "same",
                });
                expect(yield* replica.pending).toHaveLength(1);
                expect((yield* replica.get("Counter", "shared"))?.count).toBe(1);
                const conflict = yield* Effect.result(
                    replica.enqueue({ id: "same", name: "increment", parameters: { a: 1 } })
                );
                expect(Result.isFailure(conflict) && conflict.failure.kind).toBe("Conflict");
            })
        )
    );
});

test("scoped watcher hints replace idle snapshot polling and repair invalidations that arrive during a load", async () => {
    const { Queue, Stream } = await import("effect");
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const server = yield* makeOwnedBackend({
                    namespace: "watcher-server",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: { increment: execute },
                });
                const hints = yield* Queue.unbounded<void>();
                let reads = 0;
                let listeners = 0;
                let invalidateDuringLoad = false;
                const backend: OntologyBackendService = {
                    ...server,
                    changes: undefined,
                    watchSubset: () =>
                        Stream.unwrap(
                            Effect.gen(function* () {
                                yield* Effect.acquireRelease(
                                    Effect.sync(() => {
                                        listeners++;
                                    }),
                                    () =>
                                        Effect.sync(() => {
                                            listeners--;
                                        })
                                );
                                return Stream.fromQueue(hints);
                            })
                        ),
                    loadSubset: (subset) =>
                        Effect.gen(function* () {
                            reads++;
                            const snapshot = yield* server.loadSubset(subset);
                            if (invalidateDuringLoad) {
                                invalidateDuringLoad = false;
                                yield* Queue.offer(hints, undefined);
                                yield* Effect.sleep(1);
                            }
                            return snapshot;
                        }),
                };
                const replica = yield* makeReplica({
                    namespace: "watcher-local",
                    ir,
                    tables: yield* Memory.make(),
                    backend,
                    execute,
                    startSync: false,
                });
                const demand = yield* Scope.make();
                yield* Scope.provide(replica.demand({ objectType: "Counter" }), demand);
                expect(listeners).toBe(1);
                yield* replica.syncOnce;
                yield* replica.syncOnce;
                expect(reads).toBe(1);
                yield* server.invoke({ id: "other-client", name: "increment", parameters: {} });
                yield* Queue.offer(hints, undefined);
                yield* Effect.sleep(1);
                invalidateDuringLoad = true;
                // Drive sync until both asynchronous hints have been consumed;
                // one millisecond does not guarantee scheduling under CI load.
                for (let attempt = 0; attempt < 100 && reads < 3; attempt++) {
                    yield* replica.syncOnce;
                    yield* Effect.sleep(1);
                }
                expect(reads).toBe(3);
                expect((yield* replica.get("Counter", "shared"))?.count).toBe(1);
                yield* Scope.close(demand, Exit.void);
                expect(listeners).toBe(0);
                yield* replica.syncOnce;
                expect(reads).toBe(3);
            })
        )
    );
});

test("another principal's colliding journal invocation ID cannot acknowledge our pending action", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const serverTables = yield* Memory.make();
                const options = {
                    namespace: "shared-authority",
                    ir,
                    tables: serverTables,
                    mutators: { increment: execute },
                };
                const alice = yield* makeOwnedBackend({ ...options, invocationScope: "alice" });
                const bob = yield* makeOwnedBackend({ ...options, invocationScope: "bob" });
                const invocation = { id: "principal-local-id", name: "increment", parameters: {} };
                yield* alice.invoke(invocation);
                let dispatches = 0;
                const replica = yield* makeReplica({
                    namespace: "bob-local",
                    ir,
                    tables: yield* Memory.make(),
                    execute,
                    startSync: false,
                    backend: {
                        ...bob,
                        invoke: (request) =>
                            Effect.gen(function* () {
                                dispatches++;
                                return yield* bob.invoke(request);
                            }),
                    },
                });
                yield* replica.enqueue(invocation);
                yield* replica.syncOnce;
                expect(dispatches).toBe(1);
                expect(yield* replica.pending).toEqual([]);
                expect((yield* replica.get("Counter", "shared"))?.count).toBe(2);
                expect((yield* bob.loadSubset({ objectType: "Counter" })).rows[0]?.value.count).toBe(2);
            })
        )
    );
});

test("journal-maintained whole-collection coverage satisfies new primary-key and window demands without snapshot polling", async () => {
    const { eq, field } = await import("@party-stack/ontology-storage");
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeOwnedBackend({
                    namespace: "coverage-server",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: {
                        increment: (tx, invocation) =>
                            tx.put("Counter", {
                                id: invocation.id,
                                count: Number(invocation.parameters.count ?? 1),
                            }),
                    },
                });
                yield* backend.invoke({ id: "first", name: "increment", parameters: {} });
                let snapshots = 0;
                const replica = yield* makeReplica({
                    namespace: "coverage-local",
                    ir,
                    tables: yield* Memory.make(),
                    execute,
                    startSync: false,
                    backend: {
                        ...backend,
                        loadSubset: (subset) =>
                            Effect.suspend(() => {
                                snapshots++;
                                return backend.loadSubset(subset);
                            }),
                    },
                });
                const all = yield* Scope.make();
                yield* Scope.provide(replica.demand({ objectType: "Counter", query: {} }), all);
                yield* replica.syncOnce;
                yield* replica.syncOnce;
                expect(snapshots).toBe(1);
                yield* Scope.close(all, Exit.void);
                yield* replica.demand({ objectType: "Counter", query: { where: eq(field("id"), "first") } });
                yield* replica.demand({
                    objectType: "Counter",
                    query: { orderBy: [{ field: field("count"), direction: "desc" }], limit: 1 },
                });
                yield* backend.invoke({ id: "second", name: "increment", parameters: { count: 2 } });
                yield* replica.syncOnce;
                expect(snapshots).toBe(1);
                expect((yield* replica.get("Counter", "second"))?.count).toBe(2);
                expect(
                    (yield* replica.status).demands.every(
                        (demand) =>
                            demand.coveredBy?.objectType === "Counter" &&
                            Object.keys(demand.coveredBy.query ?? {}).length === 0
                    )
                ).toBe(true);
            })
        )
    );
});

test("watch-only filtered snapshots repair rows that leave a filter without treating them as deleted", async () => {
    const { PubSub, Stream } = await import("effect");
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const server = yield* makeOwnedBackend({
                    namespace: "filtered-watcher-server",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: {
                        increment: (tx, action) =>
                            action.parameters.deleted
                                ? tx.delete("Counter", String(action.parameters.id))
                                : tx.put("Counter", {
                                      id: action.parameters.id,
                                      count: action.parameters.count,
                                  }),
                    },
                });
                const hints = yield* PubSub.unbounded<void>();
                const requests: import("@party-stack/ontology-backend").BackendSubset[] = [];
                const replica = yield* makeReplica({
                    namespace: "filtered-watcher-local",
                    ir,
                    tables: yield* Memory.make(),
                    execute,
                    startSync: false,
                    backend: {
                        ...server,
                        changes: undefined,
                        watchSubset: () => Stream.fromPubSub(hints),
                        loadSubset: (subset) =>
                            Effect.suspend(() => {
                                requests.push(subset);
                                return server.loadSubset(subset);
                            }),
                    },
                });
                yield* server.invoke({ id: "seed-a", name: "increment", parameters: { id: "a", count: 1 } });
                yield* server.invoke({ id: "seed-b", name: "increment", parameters: { id: "b", count: 1 } });
                const subset = { objectType: "Counter", query: { where: eq(field("count"), 1) } };
                yield* replica.demand(subset);
                yield* Effect.yieldNow;
                yield* replica.syncOnce;
                expect((yield* replica.loadSubset("Counter", subset.query)).map((row) => row.key)).toEqual([
                    "a",
                    "b",
                ]);
                yield* server.invoke({ id: "move-a", name: "increment", parameters: { id: "a", count: 2 } });
                yield* server.invoke({
                    id: "delete-b",
                    name: "increment",
                    parameters: { id: "b", deleted: true },
                });
                yield* PubSub.publish(hints, undefined);
                yield* Effect.sleep(1);
                yield* replica.syncOnce;
                expect(yield* replica.loadSubset("Counter", subset.query)).toEqual([]);
                expect((yield* replica.get("Counter", "a"))?.count).toBe(2);
                expect(yield* replica.get("Counter", "b")).toBeUndefined();
                expect(requests.map((request) => request.query?.where?.op)).toEqual(["eq", "eq", "in"]);
                yield* replica.syncOnce;
                expect(requests).toHaveLength(3);
            })
        )
    );
});

test("primary-key coverage includes known absence and stays current through journal catch-up", async () => {
    const { eq, field } = await import("@party-stack/ontology-storage");
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeOwnedBackend({
                    namespace: "pk-server",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: {
                        increment: (tx, invocation) =>
                            tx.put("Counter", { id: invocation.parameters.id, count: 1 }),
                    },
                });
                let snapshots = 0;
                const replica = yield* makeReplica({
                    namespace: "pk-local",
                    ir,
                    tables: yield* Memory.make(),
                    execute,
                    startSync: false,
                    backend: {
                        ...backend,
                        loadSubset: (subset) =>
                            Effect.suspend(() => {
                                snapshots++;
                                return backend.loadSubset(subset);
                            }),
                    },
                });
                const first = yield* Scope.make();
                yield* Scope.provide(
                    replica.demand({ objectType: "Counter", query: { where: eq(field("id"), "new") } }),
                    first
                );
                yield* replica.syncOnce;
                expect(yield* replica.get("Counter", "new")).toBeUndefined();
                yield* Scope.close(first, Exit.void);
                yield* replica.demand({
                    objectType: "Counter",
                    query: { where: eq("new", field("id")), limit: 1 },
                });
                yield* backend.invoke({ id: "create", name: "increment", parameters: { id: "new" } });
                yield* replica.syncOnce;
                yield* replica.syncOnce;
                expect(snapshots).toBe(1);
                expect((yield* replica.get("Counter", "new"))?.count).toBe(1);
            })
        )
    );
});

test("a confirmed key reuses subset coverage until garbage collection invalidates its proof", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeOwnedBackend({
                    namespace: "key-coverage-server",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: { increment: execute },
                });
                yield* backend.invoke({ id: "seed", name: "increment", parameters: {} });
                let snapshots = 0;
                const replica = yield* makeReplica({
                    namespace: "key-coverage-local",
                    ir,
                    tables: yield* Memory.make(),
                    execute,
                    startSync: false,
                    backend: {
                        ...backend,
                        loadSubset: (subset) =>
                            Effect.suspend(() => {
                                snapshots++;
                                return backend.loadSubset(subset);
                            }),
                    },
                });
                const initial = yield* Scope.make();
                yield* Scope.provide(
                    replica.demand({ objectType: "Counter", query: { where: eq(field("count"), 1) } }),
                    initial
                );
                yield* replica.syncOnce;
                yield* Scope.close(initial, Exit.void);
                const point = { objectType: "Counter", query: { where: eq(field("id"), "shared") } };
                const reader = yield* Scope.make();
                yield* Scope.provide(replica.demand(point), reader);
                yield* replica.syncOnce;
                expect(snapshots).toBe(1);
                yield* Scope.close(reader, Exit.void);
                yield* backend.invoke({ id: "move-out-of-filter", name: "increment", parameters: {} });
                yield* replica.syncOnce;
                expect(yield* replica.collectGarbage({ olderThanMs: 0 })).toBe(1);
                expect(yield* replica.get("Counter", "shared")).toBeUndefined();
                yield* replica.demand(point);
                yield* replica.syncOnce;
                expect(snapshots).toBe(2);
                expect((yield* replica.get("Counter", "shared"))?.count).toBe(2);
            })
        )
    );
});

test("bounded coverage is not whole-collection coverage and idle journal windows do not resnapshot", async () => {
    const { field } = await import("@party-stack/ontology-storage");
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeOwnedBackend({
                    namespace: "window-server",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: { increment: execute },
                });
                let snapshots = 0;
                const replica = yield* makeReplica({
                    namespace: "window-local",
                    ir,
                    tables: yield* Memory.make(),
                    execute,
                    startSync: false,
                    backend: {
                        ...backend,
                        loadSubset: (subset) =>
                            Effect.suspend(() => {
                                snapshots++;
                                return backend.loadSubset(subset);
                            }),
                    },
                });
                const scope = yield* Scope.make();
                yield* Scope.provide(
                    replica.demand({
                        objectType: "Counter",
                        query: { orderBy: [{ field: field("count") }], limit: 1 },
                    }),
                    scope
                );
                yield* replica.syncOnce;
                yield* replica.syncOnce;
                expect(snapshots).toBe(1);
                yield* backend.invoke({ id: "new", name: "increment", parameters: {} });
                yield* replica.syncOnce;
                expect(snapshots).toBe(2);
                yield* replica.syncOnce;
                expect(snapshots).toBe(2);
                yield* Scope.close(scope, Exit.void);
                yield* replica.demand({ objectType: "Counter" });
                yield* replica.syncOnce;
                expect(snapshots).toBe(3);
            })
        )
    );
});

test("expired journal history rebuilds selected base while preserving and executing local intent once", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* makeOwnedBackend({
                    namespace: "history-reset",
                    ir,
                    tables: yield* Memory.make(),
                    history: { maxCommits: 1 },
                    mutators: { increment: execute },
                });
                let submissions = 0;
                const backend = {
                    ...owned,
                    invoke: (invocation: ActionInvocation) =>
                        Effect.sync(() => submissions++).pipe(Effect.andThen(owned.invoke(invocation))),
                };
                const replica = yield* makeReplica({
                    namespace: "history-client",
                    ir,
                    tables: yield* Memory.make(),
                    backend,
                    execute,
                    startSync: false,
                });
                yield* replica.demand({ objectType: "Counter" });
                yield* replica.syncOnce;
                for (let index = 0; index < 3; index++)
                    yield* owned.invoke({ id: `remote-${index}`, name: "increment", parameters: {} });
                yield* replica.enqueue({ id: "local", name: "increment", parameters: {} });
                yield* replica.syncOnce;
                expect(submissions).toBe(1);
                expect(yield* replica.pending).toEqual([]);
                expect((yield* replica.get("Counter", "shared"))?.count).toBe(4);
                expect((yield* owned.loadSubset({ objectType: "Counter" })).rows[0]?.value.count).toBe(4);
            })
        )
    );
});
