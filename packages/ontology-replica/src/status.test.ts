import { BackendError } from "@party-stack/ontology-backend";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { eq, field, ilike, evaluateQuery } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { makeNetworkConnectivity } from "@party-stack/runtime";
import { Cause, Deferred, Effect, Exit, Fiber, PubSub, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect, test, vi } from "vitest";
import { makeReplicaDiagnostics } from "./status.js";
import { makeReplica, makeReplicaMonitor } from "./index.js";
import type { ReplicaStatus } from "./index.js";
import type { ConnectionState } from "@party-stack/connect";

test("a failure during cancellation remains failed in load and sync diagnostics", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const diagnostics = yield* makeReplicaDiagnostics();
                const error = new BackendError({
                    operation: "loadSubset",
                    kind: "Unavailable",
                    message: "Cleanup failed",
                    retryable: true,
                });
                const mixed = Effect.failCause(Cause.combine(Cause.interrupt(), Cause.fail(error)));
                yield* Effect.exit(
                    diagnostics.load({ operation: "loadSubset", reason: "demand" }, mixed, () => ({}))
                );
                yield* Effect.exit(diagnostics.sync(mixed));
                expect(diagnostics.snapshot().loads[0]).toMatchObject({
                    outcome: "failure",
                    error: { message: "Cleanup failed" },
                });
                expect(diagnostics.snapshot().lastSync?.outcome).toBe("failure");
            })
        )
    );
});

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    actionTypes: [],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [{ name: "id", displayName: "Id", type: o.string({}) }],
        },
    ],
};

test("network and connection state remain independent and either can pause remote work", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const connectivity = yield* makeNetworkConnectivity(true);
                const events = yield* PubSub.sliding<ConnectionState>({ capacity: 1, replay: 1 });
                yield* Effect.addFinalizer(() => PubSub.shutdown(events));
                let state: ConnectionState = { status: "needs-auth" };
                const connection = {
                    get state() {
                        return state;
                    },
                    changes: Stream.fromPubSub(events),
                };
                const setConnection = (next: ConnectionState) =>
                    Effect.sync(() => {
                        state = next;
                        PubSub.publishUnsafe(events, next);
                    });
                yield* setConnection(state);
                let failAuthentication = false;
                let delayed:
                    | { entered: Deferred.Deferred<void>; finish: Deferred.Deferred<void> }
                    | undefined;
                let loads = 0,
                    writes = 0;
                const replica = yield* makeReplica({
                    namespace: "separate-availability",
                    ir: {
                        ...ir,
                        actionTypes: [{ name: "write", displayName: "Write", parameters: [], logic: [] }],
                    },
                    tables: yield* Memory.make(),
                    startSync: false,
                    connectivity,
                    connection,
                    execute: () => Effect.void,
                    backend: {
                        name: "fixture",
                        sourceId: "fixture",
                        supportsIdempotency: true,
                        pollIntervalMs: () => false,
                        queryFunction: () => Effect.void,
                        loadSubset: () =>
                            Effect.gen(function* () {
                                loads++;
                                const failed = failAuthentication;
                                const pending = delayed;
                                delayed = undefined;
                                if (pending) {
                                    yield* Deferred.succeed(pending.entered, undefined);
                                    yield* Deferred.await(pending.finish);
                                }
                                if (failed)
                                    return yield* new BackendError({
                                        operation: "loadSubset",
                                        kind: "Unauthenticated",
                                        retryable: false,
                                        message: "Sign in again.",
                                    });
                                return { complete: true, rows: [{ key: "one", value: { id: "one" } }] };
                            }),
                        applyAction: (request) =>
                            Effect.sync(() => {
                                writes++;
                                return {
                                    operationId: request.id,
                                    outcome: "committed" as const,
                                    affected: [],
                                };
                            }),
                    },
                });
                expect(replica.connectivity).toBe(connectivity);
                expect(replica.connection).toBe(connection);
                const initial = yield* Deferred.make<void>();
                const offlineActive = yield* Deferred.make<void>();
                const onlineNeedsAuth = yield* Deferred.make<void>();
                let recovered = yield* Deferred.make<void>();
                let recovering = false;
                yield* Stream.runForEach(replica.statuses, (status) =>
                    Effect.gen(function* () {
                        yield* Deferred.succeed(initial, undefined);
                        if (!status.networkOnline && status.connection?.status === "active")
                            yield* Deferred.succeed(offlineActive, undefined);
                        if (
                            status.networkOnline &&
                            status.connection?.status === "needs-auth" &&
                            status.replicationError
                        )
                            yield* Deferred.succeed(onlineNeedsAuth, undefined);
                        if (recovering && status.connection?.status === "active" && !status.replicationError)
                            yield* Deferred.succeed(recovered, undefined);
                    })
                ).pipe(Effect.forkScoped);
                yield* Deferred.await(initial);
                yield* replica.demand({ objectType: "Item" });
                yield* replica.enqueue({ id: "write-1", name: "write", parameters: {} });
                yield* replica.syncOnce;
                expect([loads, writes]).toEqual([0, 0]);
                expect(yield* replica.status).toMatchObject({
                    networkOnline: true,
                    connection: { status: "needs-auth" },
                });

                yield* connectivity.set(false);
                yield* setConnection({ status: "active" });
                yield* Deferred.await(offlineActive);
                yield* replica.syncOnce;
                expect([loads, writes]).toEqual([0, 0]);

                yield* connectivity.set(true);
                yield* replica.syncOnce;
                expect(loads).toBeGreaterThan(0);
                expect(writes).toBe(1);

                failAuthentication = true;
                yield* replica.invalidate(["Item"]);
                expect(yield* Effect.result(replica.syncOnce)).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "Unauthenticated" },
                });
                const failedLoads = loads;
                failAuthentication = false;
                expect(yield* Effect.result(replica.syncOnce)).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "Unauthenticated" },
                });
                expect(loads).toBe(failedLoads);

                yield* setConnection({ status: "needs-auth" });
                yield* replica.reportReplicationFailure(
                    new BackendError({
                        operation: "sync",
                        kind: "Unauthenticated",
                        retryable: false,
                        message: "Sign in again.",
                    })
                );
                yield* connectivity.set(false);
                yield* connectivity.set(true);
                yield* Deferred.await(onlineNeedsAuth);
                expect((yield* replica.status).replicationError?.kind).toBe("Unauthenticated");
                recovering = true;
                yield* setConnection({ status: "active" });
                yield* Deferred.await(recovered);
                expect((yield* replica.status).replicationError).toBeUndefined();
                yield* replica.syncOnce;
                expect(loads).toBe(failedLoads + 1);
                expect((yield* replica.status).demands[0]?.loadError).toBeUndefined();

                // A reply using old credentials may arrive after reauthentication.
                // It must not install a new permanent authentication failure.
                const pending = {
                    entered: yield* Deferred.make<void>(),
                    finish: yield* Deferred.make<void>(),
                };
                delayed = pending;
                failAuthentication = true;
                yield* replica.invalidate(["Item"]);
                const stale = yield* Effect.forkChild(Effect.result(replica.syncOnce));
                yield* Deferred.await(pending.entered);
                failAuthentication = false;
                recovering = false;
                recovered = yield* Deferred.make<void>();
                yield* replica.reportReplicationFailure(
                    new BackendError({
                        operation: "sync",
                        kind: "Unauthenticated",
                        retryable: false,
                        message: "Old credentials.",
                    })
                );
                recovering = true;
                yield* setConnection({ status: "needs-auth" });
                yield* setConnection({ status: "active" });
                yield* Deferred.await(recovered);
                yield* Deferred.succeed(pending.finish, undefined);
                expect(yield* Fiber.join(stale)).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "Unauthenticated" },
                });
                const beforeRepair = loads;
                yield* replica.syncOnce;
                expect(loads).toBe(beforeRepair + 1);
                expect((yield* replica.status).demands[0]?.loadError).toBeUndefined();
            })
        )
    );
});

test("inspection streams do not acquire demand, and record live loads, failures, offline state and released demand", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const entered = yield* Deferred.make<void>();
                const release = yield* Deferred.make<void>();
                const initial = yield* Deferred.make<void>();
                let requests = 0;
                let online = true;
                let fail = false;
                const replica = yield* makeReplica({
                    ir,
                    namespace: "inspect",
                    tables: yield* Memory.make(),
                    startSync: false,
                    objectCacheGc: false,
                    connectivity: { online: Effect.sync(() => online), changes: Stream.never },
                    execute: () => Effect.void,
                    backend: {
                        name: "fixture",
                        sourceId: "fixture",
                        supportsIdempotency: false,
                        applyAction: () => Effect.die("Unexpected invocation"),
                        queryFunction: () => Effect.void,
                        loadSubset: () =>
                            Effect.gen(function* () {
                                requests++;
                                yield* Deferred.succeed(entered, undefined);
                                yield* Deferred.await(release);
                                if (fail)
                                    return yield* new BackendError({
                                        kind: "Unavailable",
                                        operation: "load",
                                        message: "Disconnected",
                                        retryable: true,
                                    });
                                return {
                                    complete: false,
                                    fetchedRows: 42,
                                    pushdown: {
                                        source: "Test source",
                                        predicates: [],
                                        sorting: "none" as const,
                                        pagination: "none" as const,
                                        rechecksFilter: true,
                                        native: { language: "test", text: "opaque provider syntax" },
                                    },
                                    rows: [{ key: "one", value: { id: "one" } }],
                                };
                            }),
                    },
                });
                const updates: ReplicaStatus[] = [];
                yield* Effect.forkScoped(
                    Stream.runForEach(replica.statuses, (status) =>
                        Effect.sync(() => {
                            updates.push(status);
                        }).pipe(Effect.andThen(Deferred.succeed(initial, undefined)))
                    )
                );
                yield* Deferred.await(initial);
                expect(requests).toBe(0);
                expect(updates[0]?.demands).toEqual([]);
                const demandScope = yield* Scope.make();
                const subset = { objectType: "Item", query: { where: ilike(field("id"), "one") } };
                yield* Scope.provide(replica.demand(subset), demandScope);
                yield* Scope.provide(replica.demand(subset), demandScope);
                const syncing = yield* Effect.forkChild(replica.syncOnce);
                yield* Deferred.await(entered);
                const active = yield* replica.status;
                expect(active).toMatchObject({
                    mode: "adapter",
                    networkOnline: true,
                    syncing: true,
                    demands: [{ ...subset, references: 2, installed: 0, revision: 1 }],
                    loads: [{ operation: "loadSubset", reason: "demand", outcome: "running", subset }],
                });
                yield* Deferred.succeed(release, undefined);
                yield* Fiber.join(syncing);
                expect(yield* replica.status).toMatchObject({
                    syncing: false,
                    lastSync: { outcome: "success" },
                    demands: [{ installed: 1 }],
                    loads: [
                        {
                            rows: 1,
                            fetchedRows: 42,
                            complete: false,
                            outcome: "success",
                            pushdown: {
                                source: "Test source",
                                predicates: [],
                                sorting: "none",
                                pagination: "none",
                                rechecksFilter: true,
                                native: { language: "test", text: "opaque provider syntax" },
                            },
                        },
                    ],
                });
                fail = true;
                expect((yield* Effect.result(replica.syncOnce))._tag).toBe("Failure");
                expect(yield* replica.status).toMatchObject({
                    syncing: false,
                    lastSync: { outcome: "failure", error: { message: "Disconnected" } },
                    loads: [
                        { outcome: "success" },
                        { reason: "refresh", outcome: "failure", error: { kind: "Unavailable" } },
                    ],
                });
                online = false;
                yield* replica.syncOnce;
                expect((yield* replica.status).networkOnline).toBe(false);
                expect(requests).toBe(2);
                yield* Scope.close(demandScope, Exit.void);
                expect((yield* replica.status).demands).toEqual([]);
                expect(updates.length).toBeGreaterThan(1);
                expect(JSON.stringify((yield* replica.status).loads)).not.toContain('"value"');
            })
        )
    );
});

test("watch-maintained whole-collection coverage explains search reuse without an extra source load", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let requests = 0;
                const rows = ["hi-one", "other"].map((id) => ({ key: id, value: { id } }));
                const replica = yield* makeReplica({
                    ir,
                    namespace: "coverage-diagnostics",
                    tables: yield* Memory.make(),
                    startSync: false,
                    objectCacheGc: false,
                    execute: () => Effect.void,
                    backend: {
                        name: "fixture",
                        sourceId: "fixture",
                        supportsIdempotency: false,
                        applyAction: () => Effect.die("Unexpected invocation"),
                        queryFunction: () => Effect.void,
                        watchSubset: () => Stream.never,
                        loadSubset: (subset) =>
                            Effect.sync(() => {
                                requests++;
                                return { rows: evaluateQuery(rows, subset.query ?? {}), complete: true };
                            }),
                    },
                });
                const all = yield* Scope.make();
                yield* Scope.provide(replica.demand({ objectType: "Item" }), all);
                yield* replica.syncOnce;
                const search = { objectType: "Item", query: { where: ilike(field("id"), "hi%") } };
                yield* replica.demand(search);
                yield* replica.syncOnce;
                expect(requests).toBe(1);
                const status = yield* replica.status;
                expect(status.demands.find((demand) => demand.query?.where)).toMatchObject({
                    ...search,
                    installed: 1,
                    revision: 1,
                    coveredBy: { objectType: "Item" },
                    coverageProof: { reason: "collection", maintainedBy: "watch" },
                });
                expect(status.loads).toHaveLength(1);
                expect((yield* replica.loadSubset("Item", search.query)).map((row) => row.key)).toEqual([
                    "hi-one",
                ]);
                // Once the full collection stops being maintained, search must load its
                // own snapshot rather than retain a stale coverage explanation.
                yield* Scope.close(all, Exit.void);
                yield* replica.syncOnce;
                expect(requests).toBe(2);
                const refreshed = yield* replica.status;
                expect(refreshed.demands[0]?.coveredBy).toBeUndefined();
                expect(refreshed.demands[0]?.coverageProof).toBeUndefined();
                expect(refreshed.loads.at(-1)?.subset).toEqual(search);
            })
        )
    );
});

test.each([true, false])(
    "primary-key hits reuse maintained subset rows even when complete=%s",
    async (complete) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const requests: unknown[] = [];
                    const rows = [{ key: "hi-one", value: { id: "hi-one" } }];
                    const replica = yield* makeReplica({
                        ir,
                        namespace: `pk-proof-${complete}`,
                        tables: yield* Memory.make(),
                        startSync: false,
                        objectCacheGc: false,
                        execute: () => Effect.void,
                        backend: {
                            name: "fixture",
                            sourceId: "fixture",
                            supportsIdempotency: false,
                            applyAction: () => Effect.die("Unexpected invocation"),
                            queryFunction: () => Effect.void,
                            watchSubset: () => Stream.never,
                            loadSubset: (subset) =>
                                Effect.sync(() => {
                                    requests.push(subset.query?.where);
                                    return { rows: evaluateQuery(rows, subset.query ?? {}), complete };
                                }),
                        },
                    });
                    const broad = { objectType: "Item", query: { where: ilike(field("id"), "hi%") } };
                    const broadScope = yield* Scope.make();
                    yield* Scope.provide(replica.demand(broad), broadScope);
                    yield* replica.syncOnce;
                    if (complete) {
                        yield* replica.syncOnce;
                        expect((yield* replica.status).demands[0]?.coverageProof).toEqual({
                            reason: "query",
                            maintainedBy: "watch",
                        });
                    }
                    const point = { objectType: "Item", query: { where: eq(field("id"), "hi-one") } };
                    yield* replica.demand(point);
                    yield* replica.syncOnce;
                    expect(requests).not.toContainEqual(point.query.where);
                    expect(
                        (yield* replica.status).demands.find((d) => d.query?.where?.op === "eq")
                    ).toMatchObject({
                        coveredBy: broad,
                        coverageProof: { reason: "primary-key", maintainedBy: "watch" },
                    });
                    expect((yield* replica.loadSubset("Item", point.query)).map((row) => row.key)).toEqual([
                        "hi-one",
                    ]);
                    const missing = { objectType: "Item", query: { where: eq(field("id"), "hi-missing") } };
                    yield* replica.demand(missing);
                    yield* replica.syncOnce;
                    // Absence from a filtered or incomplete result cannot prove this key is absent upstream.
                    expect(requests).toContainEqual(missing.query.where);
                    requests.length = 0;
                    yield* Scope.close(broadScope, Exit.void);
                    yield* replica.syncOnce;
                    // The row remains readable, but losing its maintained coverage requires revalidation.
                    expect(requests).toContainEqual(point.query.where);
                })
            )
        );
    }
);

test("configured subset polling invalidates coverage on its interval and stops with demand", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let requests = 0;
                const replica = yield* makeReplica({
                    ir,
                    namespace: "polling",
                    tables: yield* Memory.make(),
                    startSync: false,
                    objectCacheGc: false,
                    execute: () => Effect.void,
                    backend: {
                        name: "fixture",
                        sourceId: "fixture",
                        supportsIdempotency: false,
                        applyAction: () => Effect.die("Unexpected invocation"),
                        queryFunction: () => Effect.void,
                        pollIntervalMs: () => 1000,
                        loadSubset: () =>
                            Effect.sync(() => {
                                requests++;
                                return { rows: [{ key: "one", value: { id: "one" } }], complete: true };
                            }),
                    },
                });
                const scope = yield* Scope.make();
                yield* Scope.provide(replica.demand({ objectType: "Item" }), scope);
                yield* replica.syncOnce;
                yield* replica.syncOnce;
                expect((yield* replica.status).demands[0]?.coverageProof).toEqual({
                    reason: "collection",
                    maintainedBy: "poll",
                    pollIntervalMs: 1000,
                });
                yield* TestClock.adjust(999);
                yield* replica.syncOnce;
                expect(requests).toBe(1);
                yield* TestClock.adjust(1);
                expect((yield* replica.status).demands[0]?.coverageProof).toBeUndefined();
                yield* replica.syncOnce;
                expect(requests).toBe(2);
                yield* Scope.close(scope, Exit.void);
                yield* TestClock.adjust(2000);
                yield* replica.syncOnce;
                expect((yield* replica.status).demands).toEqual([]);
                expect(requests).toBe(2);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});

test("disabled polling retains its snapshot without claiming an active watcher", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let requests = 0;
                const replica = yield* makeReplica({
                    ir,
                    namespace: "no-polling",
                    tables: yield* Memory.make(),
                    startSync: false,
                    objectCacheGc: false,
                    execute: () => Effect.void,
                    backend: {
                        name: "fixture",
                        sourceId: "fixture",
                        supportsIdempotency: false,
                        applyAction: () => Effect.die("Unexpected invocation"),
                        queryFunction: () => Effect.void,
                        pollIntervalMs: () => false,
                        loadSubset: () =>
                            Effect.sync(() => {
                                requests++;
                                return { rows: [{ key: "one", value: { id: "one" } }], complete: true };
                            }),
                    },
                });
                yield* replica.demand({ objectType: "Item" });
                yield* replica.syncOnce;
                yield* TestClock.adjust(60_000);
                yield* replica.syncOnce;
                const demand = (yield* replica.status).demands[0]!;
                expect(requests).toBe(1);
                expect(demand.watchers).toBe(0);
                expect(demand.coverageProof).toBeUndefined();
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});

test("load history stays bounded and cancellation does not leave running diagnostics", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let hang = false;
                const entered = yield* Deferred.make<void>();
                const replica = yield* makeReplica({
                    ir,
                    namespace: "bounded",
                    tables: yield* Memory.make(),
                    startSync: false,
                    objectCacheGc: false,
                    execute: () => Effect.void,
                    backend: {
                        name: "fixture",
                        sourceId: "fixture",
                        supportsIdempotency: false,
                        applyAction: () => Effect.die("Unexpected invocation"),
                        queryFunction: () => Effect.void,
                        loadSubset: () =>
                            Effect.gen(function* () {
                                if (hang) {
                                    yield* Deferred.succeed(entered, undefined);
                                    return yield* Effect.never;
                                }
                                return { complete: false, rows: [] };
                            }),
                    },
                });
                yield* replica.demand({ objectType: "Item" });
                for (let index = 0; index < 102; index++) yield* replica.syncOnce;
                const status = yield* replica.status;
                expect(status.loadCount).toBe(102);
                expect(status.loads).toHaveLength(100);
                hang = true;
                const working = yield* Effect.forkChild(replica.syncOnce);
                yield* Deferred.await(entered);
                yield* Fiber.interrupt(working);
                const cancelled = yield* replica.status;
                expect(cancelled.syncing).toBe(false);
                expect(cancelled.loads.at(-1)?.outcome).toBe("interrupted");
            })
        )
    );
});

test("monitor subscribes lazily, detaches its upstream stream and reports transport failures", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let subscriptions = 0;
                const stream = Stream.unwrap(
                    Effect.acquireRelease(
                        Effect.sync(() => {
                            subscriptions++;
                            return Stream.never;
                        }),
                        () =>
                            Effect.sync(() => {
                                subscriptions--;
                            })
                    )
                );
                const monitor = yield* makeReplicaMonitor(stream);
                expect(subscriptions).toBe(0);
                const first = monitor.subscribe(() => undefined);
                const second = monitor.subscribe(() => undefined);
                yield* Effect.promise(() => vi.waitFor(() => expect(subscriptions).toBe(1)));
                first();
                expect(subscriptions).toBe(1);
                second();
                yield* Effect.promise(() => vi.waitFor(() => expect(subscriptions).toBe(0)));
                const broken = yield* makeReplicaMonitor(
                    Stream.fail(
                        new BackendError({
                            operation: "status",
                            kind: "Unavailable",
                            message: "Transport closed",
                            retryable: true,
                        })
                    )
                );
                const unsubscribe = broken.subscribe(() => undefined);
                yield* Effect.promise(() =>
                    vi.waitFor(() => expect(broken.getSnapshot().error).toBe("Transport closed"))
                );
                unsubscribe();
            })
        )
    );
});
