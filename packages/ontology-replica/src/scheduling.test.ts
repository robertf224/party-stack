import { BackendError } from "@party-stack/ontology-backend";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { evaluateQuery } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { makeNetworkConnectivity } from "@party-stack/runtime";
import { Deferred, Effect, Exit, PubSub, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { makeReplica, replicaStateSource } from "./testing.js";
import type { ConnectionState } from "@party-stack/connect";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { OwnedTransaction } from "@party-stack/ontology-backend/owned";

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
    actionTypes: [{ name: "write", displayName: "Write", parameters: [], logic: [] }],
};
const connectivity = { online: Effect.succeed(true), changes: Stream.never };
const quiet: OntologyBackendService = {
    name: "fixture",
    sourceId: "fixture",
    supportsIdempotency: false,
    queryFunction: () => Effect.void,
    pollIntervalMs: () => false,
    loadSubset: () => Effect.succeed({ complete: true, rows: [] }),
    applyAction: (request) => Effect.succeed({ operationId: request.id, outcome: "committed", affected: [] }),
};

test.each([100, 600_000])(
    "receipt read-back recovery is independent of the %s ms data polling cadence",
    async (pollIntervalMs) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    let reads = 0,
                        writes = 0;
                    const failedRead = yield* Deferred.make<void>();
                    const recoveredRead = yield* Deferred.make<void>();
                    const replica = yield* makeReplica({
                        namespace: "receipt-timer",
                        ir,
                        connectivity,
                        tables: yield* Memory.make(),
                        pollIntervalMs,
                        objectCacheGc: false,
                        execute: (tx) => tx.put("Item", { id: "one", count: 1 }),
                        backend: {
                            ...quiet,
                            applyAction: (request) =>
                                Effect.sync(() => {
                                    writes++;
                                    return {
                                        operationId: request.id,
                                        outcome: "committed" as const,
                                        affected: [{ objectType: "Item", keys: ["one"] }],
                                    };
                                }),
                            loadSubset: () =>
                                Effect.gen(function* () {
                                    reads++;
                                    if (reads === 1) {
                                        yield* Deferred.succeed(failedRead, undefined);
                                        return yield* new BackendError({
                                            operation: "read",
                                            kind: "Unavailable",
                                            retryable: true,
                                            message: "Read-back temporarily unavailable.",
                                        });
                                    }
                                    yield* Deferred.succeed(recoveredRead, undefined);
                                    return {
                                        complete: true,
                                        rows: [{ key: "one", value: { id: "one", count: 1 } }],
                                    };
                                }),
                        },
                    });
                    yield* replica.enqueue({ id: "one", name: "write", parameters: {} });
                    yield* Deferred.await(failedRead);
                    yield* TestClock.adjust(4_999);
                    expect(reads).toBe(1);
                    yield* TestClock.adjust(1);
                    yield* Deferred.await(recoveredRead);
                    expect((yield* replica.awaitAction("one"))?.outcome).toBe("committed");
                    expect(writes).toBe(1);
                    expect(yield* replica.pending).toEqual([]);
                })
            ).pipe(Effect.provide(TestClock.layer()))
        );
    }
);

test("completed results expire through maintenance while data polling and the idle outbox are asleep", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const replica = yield* makeReplica({
                    namespace: "maintenance-timer",
                    ir,
                    connectivity,
                    tables: yield* Memory.make(),
                    backend: quiet,
                    execute: () => Effect.void,
                    pollIntervalMs: 600_000,
                    resultRetentionMs: 1_000,
                    objectCacheGc: false,
                });
                yield* replica.enqueue({ id: "one", name: "write", parameters: {} });
                yield* replica.awaitAction("one");
                expect(yield* replica.receipt("one")).toBeDefined();
                const pruned = yield* Deferred.make<void>();
                const changes = yield* replica.subscribeChanges;
                yield* Stream.runForEach(changes, () =>
                    Effect.gen(function* () {
                        if (!(yield* replica.receipt("one"))) yield* Deferred.succeed(pruned, undefined);
                    })
                ).pipe(Effect.forkScoped({ startImmediately: true }));
                yield* TestClock.adjust(60_000);
                yield* Deferred.await(pruned);
                expect(yield* replica.receipt("one")).toBeUndefined();
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});

test("journal failure retries on its recovery deadline rather than the data polling interval", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let pulls = 0;
                const firstAttempt = yield* Deferred.make<void>();
                const recovered = yield* Deferred.make<void>();
                yield* makeReplica({
                    namespace: "journal-timer",
                    ir,
                    connectivity,
                    tables: yield* Memory.make(),
                    execute: () => Effect.void,
                    pollIntervalMs: 600_000,
                    objectCacheGc: false,
                    backend: {
                        ...quiet,
                        changes: {
                            pull: () =>
                                Effect.gen(function* () {
                                    pulls++;
                                    if (pulls === 1) {
                                        yield* Deferred.succeed(firstAttempt, undefined);
                                        return yield* new BackendError({
                                            operation: "pull",
                                            kind: "Unavailable",
                                            retryable: true,
                                            message: "Journal unavailable.",
                                        });
                                    }
                                    yield* Deferred.succeed(recovered, undefined);
                                    return { commits: [], cursor: "head", hasMore: false };
                                }),
                        },
                    },
                });
                yield* Deferred.await(firstAttempt);
                yield* TestClock.adjust(4_999);
                expect(pulls).toBe(1);
                yield* TestClock.adjust(1);
                yield* Deferred.await(recovered);
                expect(pulls).toBe(2);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});

test("accepted work waits for evidence instead of waking on query polling or an outbox heartbeat", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let receiptApplications = 0,
                    reads = 0,
                    writes = 0;
                const accepted = yield* Deferred.make<void>();
                const replica = yield* makeReplica({
                    namespace: "accepted-events",
                    ir,
                    connectivity,
                    tables: yield* Memory.make(),
                    pollIntervalMs: 100,
                    objectCacheGc: false,
                    execute: () => Effect.void,
                    onReceipt: () =>
                        Effect.gen(function* () {
                            receiptApplications++;
                            yield* Deferred.succeed(accepted, undefined);
                        }),
                    backend: {
                        ...quiet,
                        pollIntervalMs: () => 100,
                        loadSubset: () =>
                            Effect.sync(() => {
                                reads++;
                                return { rows: [], complete: true };
                            }),
                        applyAction: (request) =>
                            Effect.sync(() => {
                                writes++;
                                return { operationId: request.id, outcome: "accepted" as const };
                            }),
                    },
                });
                yield* replica.demand({ objectType: "Item" });
                yield* replica.enqueue({ id: "one", name: "write", parameters: {} });
                yield* Deferred.await(accepted);
                yield* TestClock.adjust(10_000);
                yield* replica.invalidate(["Item"]);
                yield* replica.syncSubset({ objectType: "Item" });
                expect(reads).toBeGreaterThan(1);
                expect(receiptApplications).toBe(1);
                expect(writes).toBe(1);
                // Explicit verified commit evidence wakes confirmation without another submission.
                yield* replica.reconcile("one", { operationId: "one", outcome: "committed", affected: [] });
                expect((yield* replica.awaitAction("one"))?.outcome).toBe("committed");
                expect(writes).toBe(1);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});

test("queued retry wakes on its persisted deadline even when data polling is much slower", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let writes = 0;
                const failed = yield* Deferred.make<void>();
                const replica = yield* makeReplica({
                    namespace: "dispatch-deadline",
                    ir,
                    connectivity,
                    tables: yield* Memory.make(),
                    pollIntervalMs: 600_000,
                    objectCacheGc: false,
                    execute: () => Effect.void,
                    outbox: { maxRetries: 1, retryDelayMs: 2_000 },
                    backend: {
                        ...quiet,
                        applyAction: (request) =>
                            Effect.gen(function* () {
                                writes++;
                                if (writes === 1) {
                                    yield* Deferred.succeed(failed, undefined);
                                    return yield* new BackendError({
                                        operation: "applyAction",
                                        kind: "Unavailable",
                                        retryable: true,
                                        actionOutcome: "not-committed",
                                        message: "Try again.",
                                    });
                                }
                                return { operationId: request.id, outcome: "committed", affected: [] };
                            }),
                    },
                });
                yield* replica.enqueue({ id: "one", name: "write", parameters: {} });
                yield* Deferred.await(failed);
                yield* TestClock.adjust(1_999);
                expect(writes).toBe(1);
                yield* TestClock.adjust(1);
                expect((yield* replica.awaitAction("one"))?.outcome).toBe("committed");
                expect(writes).toBe(2);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});

test("row GC progresses during submission and retains that action's dependencies transactionally", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let count = 0;
                const entered = yield* Deferred.make<void>();
                const release = yield* Deferred.make<void>();
                const replica = yield* makeReplica({
                    namespace: "gc-during-submit",
                    ir,
                    connectivity,
                    tables: yield* Memory.make(),
                    pollIntervalMs: 600_000,
                    objectCacheGc: { sweepIntervalMs: 1_000, minUnusedAgeMs: 0, maxCandidates: 10 },
                    execute: (tx) =>
                        Effect.gen(function* () {
                            const previous = yield* tx.get("Item", "one");
                            yield* tx.put("Item", { id: "one", count: Number(previous?.count ?? 0) + 1 });
                        }),
                    backend: {
                        ...quiet,
                        loadSubset: (subset) =>
                            Effect.succeed({
                                complete: true,
                                rows: evaluateQuery(
                                    [
                                        { key: "one", value: { id: "one", count } },
                                        { key: "unused", value: { id: "unused", count: 0 } },
                                    ],
                                    subset.query
                                ),
                            }),
                        applyAction: (request) =>
                            Effect.gen(function* () {
                                yield* Deferred.succeed(entered, undefined);
                                yield* Deferred.await(release);
                                count++;
                                return {
                                    operationId: request.id,
                                    outcome: "committed",
                                    affected: [{ objectType: "Item", keys: ["one"] }],
                                };
                            }),
                    },
                });
                const demand = yield* Scope.make();
                yield* Scope.provide(replica.demand({ objectType: "Item" }), demand);
                yield* replica.syncSubset({ objectType: "Item" });
                yield* Scope.close(demand, Exit.void);
                yield* replica.enqueue({ id: "one", name: "write", parameters: {} });
                yield* Deferred.await(entered);
                yield* TestClock.adjust(1_000);
                expect(yield* replica.get("Item", "unused")).toBeUndefined();
                expect((yield* replica.get("Item", "one"))?.count).toBe(1);
                expect((yield* replica.confirmed.get("Item", "one"))?.count).toBe(0);
                yield* Deferred.succeed(release, undefined);
                yield* replica.awaitAction("one");
                expect((yield* replica.confirmed.get("Item", "one"))?.count).toBe(1);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});

test.each([false, true])(
    "parent forwarding skips unrelated prefetch and recovers a lost handoff reply (restart=%s)",
    async (restart) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const execute = (tx: OwnedTransaction) => tx.put("Item", { id: "one", count: 1 });
                    const parent = yield* makeReplica({
                        namespace: "parent",
                        ir,
                        connectivity,
                        tables: yield* Memory.make(),
                        backend: quiet,
                        execute,
                        startSync: false,
                    });
                    const original = replicaStateSource(parent);
                    let reads = 0,
                        submissions = 0;
                    const source = {
                        ...original,
                        read: (...args: Parameters<typeof original.read>) =>
                            Effect.sync(() => reads++).pipe(Effect.andThen(original.read(...args))),
                        submit: (request: Parameters<typeof original.submit>[0]) =>
                            Effect.gen(function* () {
                                submissions++;
                                const response = yield* original.submit(request);
                                if (submissions === 1)
                                    return yield* new BackendError({
                                        operation: "submit",
                                        kind: "Unavailable",
                                        retryable: true,
                                        actionOutcome: "unknown",
                                        message: "Reply lost after acceptance.",
                                    });
                                return response;
                            }),
                    };
                    const tables = yield* Memory.make();
                    const options = {
                        namespace: "child",
                        ir,
                        connectivity,
                        tables,
                        source,
                        execute,
                        startSync: false,
                        outbox: { retryDelayMs: 0 },
                    };
                    const firstScope = yield* Scope.make();
                    let child = yield* Scope.provide(makeReplica(options), firstScope);
                    yield* child.enqueue({ id: "one", name: "write", parameters: {} });
                    expect((yield* Effect.result(child.forwardParentActions(source)))._tag).toBe("Failure");
                    expect(reads).toBe(0);
                    expect(submissions).toBe(1);
                    if (restart) {
                        yield* Scope.close(firstScope, Exit.void);
                        child = yield* makeReplica(options);
                    }
                    yield* child.forwardParentActions(source);
                    expect(reads).toBe(1);
                    expect(submissions).toBe(1);
                    expect(yield* child.pending).toEqual([]);
                    expect(yield* parent.pending).toHaveLength(1);
                })
            )
        );
    }
);

test.each([false, true])(
    "new actions wake parent forwarding (incremental delivery=%s)",
    async (incremental) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const execute = (tx: OwnedTransaction) => tx.put("Item", { id: "one", count: 1 });
                    const parent = yield* makeReplica({
                        namespace: "parent-action-wake",
                        ir,
                        connectivity,
                        tables: yield* Memory.make(),
                        backend: quiet,
                        execute,
                        startSync: false,
                    });
                    const original = replicaStateSource(parent);
                    const accepted = yield* Deferred.make<void>();
                    const source = {
                        ...original,
                        subscribe: incremental ? original.subscribe : undefined,
                        submit: (request: Parameters<typeof original.submit>[0]) =>
                            original
                                .submit(request)
                                .pipe(Effect.tap(() => Deferred.succeed(accepted, undefined))),
                        accept:
                            original.accept &&
                            ((request: Parameters<NonNullable<typeof original.accept>>[0]) =>
                                original.accept!(request).pipe(
                                    Effect.tap(() => Deferred.succeed(accepted, undefined))
                                )),
                    };
                    const child = yield* makeReplica({
                        namespace: "child-action-wake",
                        ir,
                        connectivity,
                        tables: yield* Memory.make(),
                        source,
                        execute,
                        objectCacheGc: false,
                    });
                    yield* child.enqueue({ id: "one", name: "write", parameters: {} });
                    yield* Deferred.await(accepted);
                    expect((yield* parent.pending).map((entry) => entry.invocation.id)).toEqual(["one"]);
                })
            ).pipe(Effect.provide(TestClock.layer()))
        );
    }
);

test.each(["network", "authentication"] as const)(
    "%s recovery wakes queued work without waiting for data polling",
    async (mode) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const network = yield* makeNetworkConnectivity(mode !== "network");
                    let state: ConnectionState =
                        mode === "authentication" ? { status: "needs-auth" } : { status: "active" };
                    const events = yield* PubSub.sliding<ConnectionState>({ capacity: 1, replay: 1 });
                    yield* Effect.addFinalizer(() => PubSub.shutdown(events));
                    yield* PubSub.publish(events, state);
                    let writes = 0;
                    const replica = yield* makeReplica({
                        namespace: "availability-events",
                        ir,
                        tables: yield* Memory.make(),
                        connectivity: network,
                        connection: {
                            get state() {
                                return state;
                            },
                            changes: Stream.fromPubSub(events),
                        },
                        pollIntervalMs: 600_000,
                        execute: () => Effect.void,
                        objectCacheGc: false,
                        backend: {
                            ...quiet,
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
                    yield* replica.enqueue({ id: "one", name: "write", parameters: {} });
                    yield* TestClock.adjust(1);
                    expect(writes).toBe(0);
                    if (mode === "network") yield* network.set(true);
                    else {
                        state = { status: "active" };
                        yield* PubSub.publish(events, state);
                    }
                    expect((yield* replica.awaitAction("one"))?.outcome).toBe("committed");
                    expect(writes).toBe(1);
                })
            ).pipe(Effect.provide(TestClock.layer()))
        );
    }
);

test("receipt catch-up and state refresh share a journal Retry-After deadline without bypassing or extending it", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let committed = false,
                    limited = false,
                    pulls = 0,
                    writes = 0;
                const initial = yield* Deferred.make<void>();
                const throttled = yield* Deferred.make<void>();
                const replica = yield* makeReplica({
                    namespace: "shared-journal-deadline",
                    ir,
                    connectivity,
                    tables: yield* Memory.make(),
                    pollIntervalMs: 100,
                    execute: () => Effect.void,
                    objectCacheGc: false,
                    backend: {
                        ...quiet,
                        applyAction: (request) =>
                            Effect.sync(() => {
                                writes++;
                                committed = true;
                                return {
                                    operationId: request.id,
                                    outcome: "committed" as const,
                                    cursor: "one",
                                };
                            }),
                        changes: {
                            pull: () =>
                                Effect.gen(function* () {
                                    pulls++;
                                    if (!committed) {
                                        yield* Deferred.succeed(initial, undefined);
                                        return { cursor: "zero", commits: [], hasMore: false };
                                    }
                                    if (!limited) {
                                        limited = true;
                                        yield* Deferred.succeed(throttled, undefined);
                                        return yield* new BackendError({
                                            operation: "pull",
                                            kind: "RateLimited",
                                            retryable: true,
                                            retryAfterMs: 15_000,
                                            message: "Wait before journal catch-up.",
                                        });
                                    }
                                    return {
                                        cursor: "one",
                                        commits: [{ cursor: "one", operationId: "one", changes: [] }],
                                        hasMore: false,
                                    };
                                }),
                        },
                    },
                });
                yield* Deferred.await(initial);
                yield* replica.enqueue({ id: "one", name: "write", parameters: {} });
                yield* Deferred.await(throttled);
                const attempts = pulls;
                yield* TestClock.adjust(5_000);
                yield* replica.wake;
                yield* TestClock.adjust(1);
                expect(pulls).toBe(attempts);
                yield* TestClock.adjust(9_999);
                expect((yield* replica.awaitAction("one"))?.outcome).toBe("committed");
                // A regular data check can also run once confirmation has settled.
                // Neither path may issue a request before the shared deadline.
                expect(pulls).toBeGreaterThan(attempts);
                expect(writes).toBe(1);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});
