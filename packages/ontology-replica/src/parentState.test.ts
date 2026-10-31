import { BackendError } from "@party-stack/ontology-backend";
import { clientRegistry } from "@party-stack/ontology-backend/clients";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o } from "@party-stack/ontology-spec";
import { evaluateQuery } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Effect, Exit, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { connectReplicaParent, makeReplica, replicaStateSource } from "./index.js";
import type { ClientSubmission, ReplicaOptions, ReplicaService, ReplicaStateSnapshot } from "./index.js";
import type { ActionRequest, OntologyBackendService } from "@party-stack/ontology-backend";
import type { OntologyIR } from "@party-stack/ontology-spec";

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
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "count", displayName: "Count", type: o.integer({}) },
            ],
        },
    ],
    actionTypes: [
        {
            name: "increment",
            displayName: "Increment",
            parameters: [{ name: "delta", displayName: "Delta", type: o.integer({}) }],
            logic: [],
        },
    ],
};
const invocation = (id: string, delta: number): ActionRequest => ({
    id,
    name: "increment",
    parameters: { delta },
});
const execute: ReplicaOptions["execute"] = (tx, action) =>
    Effect.gen(function* () {
        const row = yield* tx.get("Counter", "one");
        yield* tx.put("Counter", {
            id: "one",
            count: Number(row?.count ?? 0) + Number(action.parameters.delta),
        });
    });
const count = (replica: ReplicaService) => Effect.map(replica.get("Counter", "one"), (row) => row?.count);
const failure = () =>
    new BackendError({
        operation: "test",
        kind: "NotImplemented",
        message: "Child must not dispatch or fetch through a backend.",
        retryable: false,
    });

const fixture = Effect.fnUntraced(function* () {
    const tables = yield* Memory.make();
    let serverCount = 10;
    const submitted: string[] = [];
    const backend: OntologyBackendService = {
        name: "authoritative",
        sourceId: "authoritative",
        supportsIdempotency: false,
        loadSubset: (subset) =>
            Effect.sync(() => ({
                complete: true,
                rows: evaluateQuery([{ key: "one", value: { id: "one", count: serverCount } }], subset.query),
            })),
        applyAction: (action) =>
            Effect.sync(() => {
                submitted.push(action.id);
                serverCount += Number(action.parameters.delta);
                return {
                    operationId: action.id,
                    outcome: "committed" as const,
                    affected: [{ objectType: "Counter", keys: ["one"] }],
                };
            }),
        queryFunction: () => Effect.void,
    };
    const options: ReplicaOptions = {
        namespace: "parent",
        ir,
        tables,
        backend,
        execute,
        startSync: false,
        objectCacheGc: false,
    };
    const parentScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(parentScope, Exit.void));
    const parent = yield* Scope.provide(makeReplica(options), parentScope);
    const demand = yield* Scope.make();
    yield* Scope.provide(parent.demand({ objectType: "Counter" }), demand);
    yield* parent.syncOnce;
    yield* Scope.close(demand, Exit.void);
    return { parent, parentScope, options, submitted, serverCount: () => serverCount };
});

const client = Effect.fnUntraced(function* (
    snapshot: ReplicaStateSnapshot,
    settings?: { tables?: ReplicaOptions["tables"]; publish?: ReplicaOptions["publish"] }
) {
    const tables = settings?.tables ?? (yield* Memory.make());
    const options: ReplicaOptions = {
        namespace: "child",
        ir,
        tables,
        execute,
        startSync: false,
        objectCacheGc: false,
        source: {
            sourceId: snapshot.sourceId,
            supportsIdempotency: true,
            openClient: () => Effect.fail(failure()),
            read: () => Effect.fail(failure()),
            acknowledge: () => Effect.fail(failure()),
            demand: () => Effect.void,
            subscribeChanges: Effect.succeed(Stream.never),
            submit: () => Effect.fail(failure()),
        },
        publish: settings?.publish,
    };
    const replica = yield* makeReplica(options);
    yield* replica.retainLocal("Counter");
    yield* replica.retainActions();
    yield* replica.receiveParentState(snapshot);
    return { replica, options };
});

const until = Effect.fnUntraced(function* (condition: Effect.Effect<boolean, BackendError>) {
    for (let i = 0; i < 500; i++) {
        if (yield* condition) return;
        yield* Effect.sleep(2);
    }
    throw new Error("Parent connection did not converge.");
});

test("subset readiness never forwards child actions or drains the parent's outbox", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const source = replicaStateSource(f.parent);
                yield* f.parent.enqueue(invocation("parent-write", 1));
                const child = yield* makeReplica({
                    namespace: "read-only-readiness",
                    ir,
                    tables: yield* Memory.make(),
                    source,
                    execute,
                    startSync: false,
                    objectCacheGc: false,
                });
                const subset = { objectType: "Counter" };
                yield* child.demand(subset);
                yield* child.enqueue(invocation("child-write", 2));
                yield* child.syncSubset(subset);
                expect(f.submitted).toEqual([]);
                expect((yield* f.parent.pending).map((entry) => entry.invocation.id)).toEqual([
                    "parent-write",
                ]);
                expect(
                    (yield* child.pending).find((entry) => entry.invocation.id === "child-write")
                ).toMatchObject({ state: "queued", attempts: 0 });
                expect(yield* count(child)).toBe(13);
            })
        )
    );
});

test("a protocol source starts automatically without a backend adapter or mode flag", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const child = yield* makeReplica({
                    namespace: "automatic",
                    ir,
                    tables: yield* Memory.make(),
                    source: replicaStateSource(f.parent),
                    execute,
                    objectCacheGc: false,
                });
                yield* child.retainLocal("Counter");
                yield* child.syncOnce;
                expect(yield* count(child)).toBe(10);
                yield* child.enqueue(invocation("B", 1));
                yield* until(Effect.map(child.pending, (pending) => pending.length === 0));
                expect((yield* f.parent.pending).map((action) => action.invocation.id)).toEqual(["B"]);
                expect(yield* count(child)).toBe(11);
            })
        )
    );
});

test("repeated handoffs compact admission details and reuse one client watermark", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const source = replicaStateSource(f.parent);
                const child = (yield* client(yield* f.parent.snapshotState)).replica;
                const records = clientRegistry("parent", f.parent.sourceId);
                for (let sequence = 1; sequence <= 25; sequence++) {
                    yield* child.enqueue(invocation(`B-${sequence}`, 1));
                    yield* child.syncParent(source);
                    expect(yield* child.pending).toEqual([]);
                    expect(yield* f.options.tables.query(records.submissions)).toEqual([]);
                    yield* f.parent.syncOnce;
                    yield* child.syncParent(source);
                }
                const clients = yield* f.options.tables.query(records.clients);
                expect(clients.length).toBe(1);
                expect(clients[0]?.value.acceptedThrough).toBe(25);
                expect(clients[0]?.value.acknowledgedThrough).toBe(25);
                expect(f.submitted.length).toBe(25);
                expect(yield* count(child)).toBe(35);
            })
        )
    );
});

test("a protocol source without keyed idempotency pauses an ambiguous submission", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const child = (yield* client(yield* f.parent.snapshotState)).replica;
                let effects = 0;
                const source = {
                    ...replicaStateSource(f.parent),
                    supportsIdempotency: false,
                    submit: () =>
                        Effect.gen(function* () {
                            effects++;
                            return yield* new BackendError({
                                operation: "proxy",
                                kind: "Unavailable",
                                retryable: true,
                                message: "Provider response lost.",
                            });
                        }),
                };
                yield* child.enqueue(invocation("B", 1));
                expect((yield* Effect.result(child.syncParent(source)))._tag).toBe("Failure");
                expect((yield* child.pending)[0]?.state).toBe("blocked");
                yield* child.syncParent(source);
                expect(effects).toBe(1);
                expect((yield* Effect.result(child.retry("B")))._tag).toBe("Failure");
            })
        )
    );
});

test("scoped parent connections transfer local actions and shared progress automatically", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const snapshot = yield* f.parent.snapshotState;
                const first = (yield* client(snapshot)).replica;
                const second = (yield* client(snapshot)).replica;
                yield* connectReplicaParent(first, replicaStateSource(f.parent));
                yield* connectReplicaParent(second, replicaStateSource(f.parent));
                yield* first.enqueue(invocation("B", 1));
                yield* until(
                    Effect.gen(function* () {
                        return (yield* count(second)) === 11 && (yield* first.pending).length === 0;
                    })
                );
                expect((yield* f.parent.pending).map((entry) => entry.invocation.id)).toEqual(["B"]);
                expect(yield* first.actionStatus("B")).toMatchObject({
                    parentAcceptance: { sourceId: snapshot.sourceId },
                    pending: { state: "queued" },
                });
                // Acceptance by a parent is observable before an upstream receipt exists.
                expect((yield* first.actionStatus("B")).receipt).toBeUndefined();
                expect(f.submitted).toEqual([]);
                yield* f.parent.syncOnce;
                yield* until(Effect.map(second.receipt("B"), (receipt) => receipt?.outcome === "committed"));
                expect(yield* count(first)).toBe(11);
                expect(yield* count(second)).toBe(11);
                expect(f.submitted).toEqual(["B"]);
            })
        )
    );
});

test("lost submit reply protects the local invocation and recovers by importing acceptance", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const child = (yield* client(yield* f.parent.snapshotState)).replica;
                const source = replicaStateSource(f.parent);
                let submissions = 0;
                yield* child.enqueue(invocation("B", 1));
                const lostReply = {
                    ...source,
                    submit: Effect.fnUntraced(function* (request: ClientSubmission) {
                        submissions++;
                        yield* source.submit(request);
                        return yield* new BackendError({
                            operation: "test",
                            kind: "Unavailable",
                            retryable: true,
                            message: "Reply lost.",
                        });
                    }),
                };
                expect((yield* Effect.result(child.syncParent(lostReply)))._tag).toBe("Failure");
                expect((yield* child.pending)[0]?.state).toBe("queued");
                expect((yield* child.actionStatus("B")).parentAcceptance).toBeUndefined();
                expect((yield* Effect.result(child.remove("B")))._tag).toBe("Failure");
                expect((yield* Effect.result(child.edit("B", invocation("B", 5))))._tag).toBe("Failure");
                yield* child.retry("B");
                expect((yield* Effect.result(child.remove("B")))._tag).toBe("Failure");
                yield* child.syncParent(lostReply);
                expect(submissions).toBe(1);
                expect(yield* child.pending).toEqual([]);
                expect(yield* count(child)).toBe(11);
                yield* f.parent.syncOnce;
                yield* child.syncParent(source);
                expect(f.submitted).toEqual(["B"]);
                expect((yield* child.actionStatus("B")).receipt?.outcome).toBe("committed");
            })
        )
    );
});

test("closing a connection interrupts transfer but preserves already accepted work", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const child = (yield* client(yield* f.parent.snapshotState)).replica;
                const source = replicaStateSource(f.parent);
                const accepted = yield* Deferred.make<void>();
                const connectionScope = yield* Scope.make();
                const slowSource = {
                    ...source,
                    submit: Effect.fnUntraced(function* (request: ClientSubmission) {
                        yield* source.submit(request);
                        yield* Deferred.succeed(accepted, undefined);
                        return yield* Effect.never;
                    }),
                };
                const connection = yield* Scope.provide(
                    connectReplicaParent(child, slowSource),
                    connectionScope
                );
                yield* child.enqueue(invocation("B", 1));
                yield* Deferred.await(accepted);
                yield* Scope.close(connectionScope, Exit.void);
                expect((yield* Effect.result(connection.syncOnce))._tag).toBe("Failure");
                expect((yield* child.pending)[0]?.state).toBe("sending");
                expect((yield* f.parent.pending).map((entry) => entry.invocation.id)).toEqual(["B"]);
                yield* f.parent.enqueue(invocation("C", 3));
                expect(yield* count(child)).toBe(11);
                yield* child.syncParent(source);
                expect(yield* child.pending).toEqual([]);
                expect(yield* count(child)).toBe(14);
                yield* f.parent.syncOnce;
                expect(f.submitted).toEqual(["B", "C"]);
            })
        )
    );
});

test("the same parent connection composes across an intermediate memory Replica", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const middle = (yield* client(yield* f.parent.snapshotState)).replica;
                const leaf = (yield* client(yield* middle.snapshotState)).replica;
                yield* connectReplicaParent(middle, replicaStateSource(f.parent));
                yield* connectReplicaParent(leaf, replicaStateSource(middle));
                yield* leaf.enqueue(invocation("B", 1));
                yield* until(
                    Effect.gen(function* () {
                        return (
                            (yield* leaf.pending).length === 0 &&
                            (yield* middle.pending).length === 0 &&
                            (yield* f.parent.pending).length === 1
                        );
                    })
                );
                expect(yield* count(leaf)).toBe(11);
                expect(yield* count(middle)).toBe(11);
                expect((yield* leaf.actionStatus("B")).parentAcceptance?.sourceId).toBe(
                    (yield* middle.snapshotState).sourceId
                );
                yield* f.parent.syncOnce;
                yield* until(Effect.map(leaf.receipt("B"), (receipt) => receipt?.outcome === "committed"));
                expect(f.submitted).toEqual(["B"]);
                expect(yield* count(leaf)).toBe(11);
            })
        )
    );
});

test("connection retries unavailable submissions and retains non-optimistic behavior", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const child = (yield* client(yield* f.parent.snapshotState)).replica;
                const source = replicaStateSource(f.parent);
                let online = false;
                const connection = yield* connectReplicaParent(
                    child,
                    {
                        ...source,
                        submit: Effect.fnUntraced(function* (request: ClientSubmission) {
                            if (!online)
                                return yield* new BackendError({
                                    operation: "test",
                                    kind: "Unavailable",
                                    retryable: true,
                                    message: "Offline.",
                                });
                            return yield* source.submit(request);
                        }),
                    },
                    { retryIntervalMs: 5 }
                );
                yield* child.enqueue(invocation("B", 1), { optimistic: false });
                yield* until(Effect.map(connection.lastError, (error) => error?.kind === "Unavailable"));
                expect(yield* count(child)).toBe(10);
                online = true;
                yield* until(Effect.map(child.pending, (pending) => pending.length === 0));
                expect((yield* f.parent.pending)[0]?.optimistic).toBe(false);
                expect(yield* count(f.parent)).toBe(10);
                yield* until(Effect.map(connection.lastError, (error) => error === undefined));
                yield* f.parent.syncOnce;
                yield* until(Effect.map(child.receipt("B"), (receipt) => receipt?.outcome === "committed"));
                expect(yield* count(child)).toBe(11);
                expect(f.submitted).toEqual(["B"]);
            })
        )
    );
});

test("an offline initial read preserves cached state and retries the connection", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const child = (yield* client(yield* f.parent.snapshotState)).replica;
                const source = replicaStateSource(f.parent);
                let online = false;
                const connection = yield* connectReplicaParent(
                    child,
                    {
                        ...source,
                        read: (session, view) =>
                            online
                                ? source.read(session, view)
                                : Effect.fail(
                                      new BackendError({
                                          operation: "test.read",
                                          kind: "Unavailable",
                                          retryable: true,
                                          message: "Offline.",
                                      })
                                  ),
                    },
                    { retryIntervalMs: 5 }
                );
                expect((yield* connection.lastError)?.kind).toBe("Unavailable");
                expect(yield* count(child)).toBe(10);
                yield* child.enqueue(invocation("offline", 1));
                expect(yield* count(child)).toBe(11);
                online = true;
                yield* until(Effect.map(child.pending, (pending) => pending.length === 0));
                expect((yield* f.parent.pending)[0]?.invocation.id).toBe("offline");
                expect(yield* count(child)).toBe(11);
            })
        )
    );
});

test("a failed change stream reacquires its subscription and refreshes missed changes", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const child = (yield* client(yield* f.parent.snapshotState)).replica;
                const source = replicaStateSource(f.parent);
                let subscriptions = 0;
                yield* connectReplicaParent(
                    child,
                    {
                        ...source,
                        subscribeChanges: Effect.gen(function* () {
                            subscriptions++;
                            if (subscriptions === 1)
                                return Stream.fail(
                                    new BackendError({
                                        operation: "test.changes",
                                        kind: "Unavailable",
                                        retryable: true,
                                        message: "Disconnected.",
                                    })
                                );
                            yield* f.parent.enqueue(invocation("missed", 1));
                            return Stream.never;
                        }),
                    },
                    { retryIntervalMs: 5, heartbeatIntervalMs: 60_000 }
                );
                yield* until(Effect.map(count(child), (value) => value === 11));
                expect(subscriptions).toBe(2);
                expect((yield* f.parent.pending)[0]?.invocation.id).toBe("missed");
            })
        )
    );
});

test("a fresh child recognizes inherited pending and completed invocation identities", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                yield* f.parent.enqueue(invocation("B", 1));
                const child = (yield* client(yield* f.parent.snapshotState)).replica;
                yield* child.enqueue(invocation("B", 1));
                expect(yield* child.pending).toEqual([]);
                expect(yield* count(child)).toBe(11);
                expect((yield* Effect.result(child.enqueue(invocation("B", 5))))._tag).toBe("Failure");
                yield* f.parent.syncOnce;
                const fresh = (yield* client(yield* f.parent.snapshotState)).replica;
                yield* fresh.enqueue(invocation("B", 1));
                expect(yield* fresh.pending).toEqual([]);
                expect((yield* fresh.receipt("B"))?.outcome).toBe("committed");
                expect(yield* count(fresh)).toBe(11);
                expect(f.submitted).toEqual(["B"]);
            })
        )
    );
});

test("two memory clients use the same Replica engine and hand off increments without double application", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                yield* f.parent.enqueue(invocation("A", 2));
                const initial = yield* f.parent.snapshotState;
                let first: ReplicaService | undefined;
                const observed: unknown[] = [];
                first = (yield* client(initial, {
                    publish: Effect.gen(function* () {
                        if (first) observed.push(yield* count(first));
                    }).pipe(Effect.orDie),
                })).replica;
                const second = (yield* client(initial)).replica;
                yield* first.enqueue(invocation("B", 1));
                yield* second.enqueue(invocation("C", 3));
                expect(yield* count(first)).toBe(13);
                expect(yield* count(second)).toBe(15);
                yield* f.parent.enqueue((yield* first.pending)[0]!.invocation);
                observed.length = 0;
                const accepted = yield* f.parent.snapshotState;
                yield* first.receiveParentState(accepted);
                yield* second.receiveParentState(accepted);
                expect(observed).toEqual([13]);
                expect(yield* first.pending).toEqual([]);
                expect((yield* first.parentState)?.pending.map((entry) => entry.invocation.id)).toEqual([
                    "A",
                    "B",
                ]);
                expect((yield* first.actionStatus("B")).pending?.invocation.id).toBe("B");
                expect((yield* first.confirmed.get("Counter", "one"))?.count).toBe(10);
                expect(yield* count(second)).toBe(16);
                expect((yield* second.pending).map((entry) => entry.invocation.id)).toEqual(["C"]);
                expect(f.submitted).toEqual([]);
                yield* first.enqueue(invocation("B", 1));
                expect(yield* first.pending).toEqual([]);
                expect(yield* count(first)).toBe(13);
                yield* f.parent.syncOnce;
                const confirmed = yield* f.parent.snapshotState;
                yield* first.receiveParentState(confirmed);
                yield* second.receiveParentState(confirmed);
                expect(f.submitted).toEqual(["A", "B"]);
                expect(yield* count(first)).toBe(13);
                expect(yield* count(second)).toBe(16);
                expect((yield* first.actionStatus("B")).receipt?.outcome).toBe("committed");
                expect((yield* second.actionStatus("B")).receipt?.outcome).toBe("committed");
                yield* f.parent.enqueue((yield* second.pending)[0]!.invocation);
                yield* second.receiveParentState(yield* f.parent.snapshotState);
                yield* f.parent.syncOnce;
                yield* second.receiveParentState(yield* f.parent.snapshotState);
                expect(yield* count(second)).toBe(16);
                expect(f.serverCount()).toBe(16);
            })
        )
    );
});

test("lost acceptance replies, duplicate snapshots and older snapshots do not repeat an action", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const before = yield* f.parent.snapshotState;
                const child = (yield* client(before)).replica;
                yield* child.enqueue(invocation("B", 1));
                yield* f.parent.enqueue(invocation("B", 1));
                // The enqueue reply is lost; the state stream establishes acceptance.
                const accepted = yield* f.parent.snapshotState;
                yield* child.receiveParentState(accepted);
                yield* child.receiveParentState(before);
                yield* child.receiveParentState(accepted);
                yield* f.parent.enqueue(invocation("B", 1));
                expect((yield* f.parent.pending).map((entry) => entry.invocation.id)).toEqual(["B"]);
                expect(yield* child.pending).toEqual([]);
                expect(yield* count(child)).toBe(11);
                expect(f.submitted).toEqual([]);
                yield* f.parent.syncOnce;
                yield* child.receiveParentState(yield* f.parent.snapshotState);
                expect(f.submitted).toEqual(["B"]);
                expect(yield* count(child)).toBe(11);
            })
        )
    );
});

test("removing shared pending work rebases the child's remaining local action", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                yield* f.parent.enqueue(invocation("A", 2));
                const child = (yield* client(yield* f.parent.snapshotState)).replica;
                yield* child.enqueue(invocation("B", 1));
                expect(yield* count(child)).toBe(13);
                yield* f.parent.remove("A");
                yield* child.receiveParentState(yield* f.parent.snapshotState);
                expect(yield* count(child)).toBe(11);
                expect((yield* child.pending).map((entry) => entry.invocation.id)).toEqual(["B"]);
            })
        )
    );
});

test("parent restart keeps identity; reset, conflicting payloads and invalid rows cannot corrupt the child", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                yield* f.parent.enqueue(invocation("B", 1));
                const accepted = yield* f.parent.snapshotState;
                const child = (yield* client(accepted)).replica;
                yield* child.enqueue(invocation("C", 3));
                yield* Scope.close(f.parentScope, Exit.void);
                const reopened = yield* makeReplica(f.options);
                const recovered = yield* reopened.snapshotState;
                expect(recovered.sourceId).toBe(accepted.sourceId);
                expect(recovered.revision).toBeGreaterThan(accepted.revision);
                yield* child.receiveParentState(recovered);
                expect(yield* count(child)).toBe(14);
                const conflicting = {
                    ...recovered,
                    objects: recovered.objects.map((object) => ({ ...object, overrides: [] })),
                };
                expect((yield* Effect.result(child.receiveParentState(conflicting)))._tag).toBe("Failure");
                const malformed = {
                    ...recovered,
                    revision: recovered.revision + 1,
                    objects: recovered.objects.map((object) => ({
                        ...object,
                        base: [{ key: "one", value: { id: "wrong", count: 999 } }],
                    })),
                };
                expect((yield* Effect.result(child.receiveParentState(malformed)))._tag).toBe("Failure");
                const reset = yield* makeReplica({ ...f.options, tables: yield* Memory.make() });
                expect(
                    (yield* Effect.result(child.receiveParentState(yield* reset.snapshotState)))._tag
                ).toBe("Failure");
                expect(yield* count(child)).toBe(14);
                expect((yield* child.pending).map((entry) => entry.invocation.id)).toEqual(["C"]);
                // Matching IDs with different payloads cannot acknowledge our own action.
                yield* reopened.enqueue(invocation("C", 8));
                expect(
                    (yield* Effect.result(child.receiveParentState(yield* reopened.snapshotState)))._tag
                ).toBe("Failure");
                expect(yield* count(child)).toBe(14);
            })
        )
    );
});

test("memory client restart retains handoff identity and never dispatches mirrored work", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const tables = yield* Memory.make();
                const scope = yield* Scope.make();
                const first = yield* Scope.provide(client(yield* f.parent.snapshotState, { tables }), scope);
                yield* first.replica.enqueue(invocation("B", 1));
                yield* f.parent.enqueue(invocation("B", 1));
                yield* first.replica.receiveParentState(yield* f.parent.snapshotState);
                yield* Scope.close(scope, Exit.void);
                expect((yield* f.parent.pending).map((entry) => entry.invocation.id)).toEqual(["B"]);
                expect(
                    (yield* Effect.result(makeReplica({ ...f.options, namespace: "child", tables })))._tag
                ).toBe("Failure");
                const reopened = yield* makeReplica(first.options);
                yield* reopened.enqueue(invocation("B", 1));
                expect(yield* reopened.pending).toEqual([]);
                expect(yield* count(reopened)).toBe(11);
                const dispatch = yield* Effect.result(reopened.syncOnce);
                expect(dispatch).toMatchObject({ _tag: "Failure", failure: { kind: "NotImplemented" } });
                expect(f.submitted).toEqual([]);
            })
        )
    );
});

test("an expired parent session renews without losing queued work or reusing its old sequence", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* makeOwnedBackend({
                    namespace: "expired-parent",
                    ir,
                    tables: yield* Memory.make(),
                    clients: { sessionIdleTimeoutMs: 100 },
                    mutators: { increment: execute },
                });
                const child = yield* makeReplica({
                    namespace: "expired-child",
                    ir,
                    tables: yield* Memory.make(),
                    source: owned.protocol,
                    execute,
                    objectCacheGc: false,
                    startSync: false,
                });
                yield* child.demand({ objectType: "Counter" });
                yield* child.syncOnce;
                yield* child.enqueue(invocation("first", 1));
                yield* child.syncOnce;
                yield* TestClock.adjust(101);
                yield* child.enqueue(invocation("second", 2));
                yield* child.syncOnce;
                expect(yield* child.pending).toEqual([]);
                expect(yield* count(child)).toBe(3);
                expect((yield* owned.loadSubset({ objectType: "Counter" })).rows[0]?.value.count).toBe(3);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});
