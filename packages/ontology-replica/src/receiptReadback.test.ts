import { ActionReceiptSchema, BackendError } from "@party-stack/ontology-backend";
import { o } from "@party-stack/ontology-spec";
import { evaluateQuery, field, inArray } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Effect, Exit, Fiber, Schema, Scope } from "effect";
import { expect, test } from "vitest";
import { makeReplica } from "./index.js";
import type { ActionReceipt, BackendSubset, OntologyBackendService } from "@party-stack/ontology-backend";
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
    actionTypes: [{ name: "increment", displayName: "Increment", parameters: [], logic: [] }],
};

test("partial synthetic receipt identities survive restart and do not hide automation effects", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const requests: BackendSubset[] = [];
                let invocations = 0;
                let available = false;
                const definition: OntologyIR = {
                    ...ir,
                    objectTypes: [ir.objectTypes[0]!, { ...ir.objectTypes[0]!, name: "Mirror" }],
                };
                const receipt = Schema.decodeUnknownSync(ActionReceiptSchema)({
                    invocationId: "once",
                    outcome: "committed",
                    affected: [{ objectType: "Counter", keys: ["one"] }],
                    affectedComplete: false,
                });
                const backend: OntologyBackendService = {
                    name: "test",
                    sourceId: "test",
                    supportsIdempotency: false,
                    invoke: () =>
                        Effect.sync(() => {
                            invocations++;
                            return receipt;
                        }),
                    loadSubset: (subset) =>
                        Effect.suspend(() => {
                            requests.push(subset);
                            if (!available)
                                return Effect.fail(
                                    new BackendError({
                                        operation: "read",
                                        kind: "Unavailable",
                                        retryable: true,
                                        message: "Offline",
                                    })
                                );
                            return Effect.succeed({
                                complete: true,
                                rows:
                                    subset.objectType === "Counter"
                                        ? [
                                              { key: "one", value: { id: "one", count: 2 } },
                                              { key: "trigger", value: { id: "trigger", count: 7 } },
                                          ]
                                        : [{ key: "mirror", value: { id: "mirror", count: 99 } }],
                            });
                        }),
                    queryFunction: () => Effect.void,
                };
                const options = {
                    namespace: "partial-receipt",
                    ir: definition,
                    tables,
                    backend,
                    startSync: false,
                    outbox: { retryDelayMs: 0 },
                    execute: () => Effect.void,
                };
                const scope = yield* Scope.make();
                const first = yield* Scope.provide(makeReplica(options), scope);
                yield* first.enqueue({ id: "once", name: "increment", parameters: {} });
                expect((yield* Effect.result(first.syncOnce))._tag).toBe("Failure");
                expect((yield* first.pending)[0]?.receipt).toEqual(receipt);
                yield* Scope.close(scope, Exit.void);
                requests.length = 0;
                available = true;
                const reopened = yield* makeReplica(options);
                yield* reopened.syncOnce;
                expect(requests).toEqual([{ objectType: "Counter" }, { objectType: "Mirror" }]);
                expect((yield* reopened.get("Counter", "trigger"))?.count).toBe(7);
                expect((yield* reopened.get("Mirror", "mirror"))?.count).toBe(99);
                expect(yield* reopened.pending).toEqual([]);
                expect(invocations).toBe(1);
            })
        )
    );
});

test("receipt targets read only changed identities and publish read-back with overlay removal atomically", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                let rows = [
                    { key: "one", value: { id: "one", count: 1 } },
                    { key: "unrelated", value: { id: "unrelated", count: 5 } },
                ];
                const requests: BackendSubset[] = [];
                const observed: (number | undefined)[] = [];
                let replica: Effect.Success<ReturnType<typeof makeReplica>> | undefined;
                const backend: OntologyBackendService = {
                    name: "test",
                    sourceId: "test",
                    supportsIdempotency: false,
                    loadSubset: (subset) =>
                        Effect.sync(() => {
                            requests.push(subset);
                            return { rows: evaluateQuery(rows, subset.query), complete: true };
                        }),
                    invoke: (invocation) =>
                        Effect.sync(() => {
                            rows = [{ key: "one", value: { id: "one", count: 2 } }, rows[1]!];
                            return {
                                invocationId: invocation.id,
                                outcome: "committed",
                                affected: [{ objectType: "Counter", keys: ["one"] }],
                            } satisfies ActionReceipt;
                        }),
                    queryFunction: () => Effect.succeed(undefined),
                };
                replica = yield* makeReplica({
                    namespace: "targeted-receipt",
                    ir,
                    tables,
                    backend,
                    startSync: false,
                    outbox: { retryDelayMs: 0 },
                    publish: Effect.gen(function* () {
                        if (replica)
                            observed.push(
                                (yield* replica.get("Counter", "one"))?.count as number | undefined
                            );
                    }).pipe(Effect.orDie),
                    execute: (tx) =>
                        Effect.gen(function* () {
                            const value = yield* tx.get("Counter", "one");
                            yield* tx.put("Counter", { id: "one", count: Number(value?.count ?? 0) + 1 });
                        }),
                });
                const demand = yield* Scope.make();
                yield* Scope.provide(replica.demand({ objectType: "Counter" }), demand);
                yield* replica.syncOnce;
                yield* Scope.close(demand, Exit.void);
                requests.length = 0;
                yield* replica.enqueue({ id: "increment", name: "increment", parameters: {} });
                observed.length = 0;
                yield* replica.syncOnce;
                expect(requests).toEqual([
                    { objectType: "Counter", query: { where: inArray(field("id"), ["one"]) } },
                ]);
                expect(new Set(observed)).toEqual(new Set([2]));
                expect((yield* replica.get("Counter", "unrelated"))?.count).toBe(5);
                expect(yield* replica.pending).toEqual([]);
            })
        )
    );
});

test("read-back failure retains the receipt across restart and never redispatches an acknowledged action", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                let invocations = 0;
                let phase: "offline" | "incomplete" | "ready" = "offline";
                const backend: OntologyBackendService = {
                    name: "test",
                    sourceId: "test",
                    supportsIdempotency: false,
                    invoke: (invocation) =>
                        Effect.sync(() => {
                            invocations++;
                            return {
                                invocationId: invocation.id,
                                outcome: "committed",
                                operationId: "remote-operation",
                                affected: [{ objectType: "Counter", keys: ["one"] }],
                            };
                        }),
                    loadSubset: () =>
                        phase === "offline"
                            ? Effect.fail(
                                  new BackendError({
                                      operation: "read",
                                      kind: "Unavailable",
                                      message: "Offline",
                                      retryable: true,
                                  })
                              )
                            : Effect.succeed({
                                  complete: phase === "ready",
                                  rows: [{ key: "one", value: { id: "one", count: 2 } }],
                              }),
                    queryFunction: () => Effect.succeed(undefined),
                };
                const settings = {
                    namespace: "receipt-restart",
                    ir,
                    tables,
                    backend,
                    startSync: false,
                    outbox: { retryDelayMs: 0 },
                    execute: () => Effect.void,
                };
                const scope = yield* Scope.make();
                const first = yield* Scope.provide(makeReplica(settings), scope);
                yield* first.enqueue({ id: "once", name: "increment", parameters: {} });
                expect((yield* Effect.result(first.syncOnce))._tag).toBe("Failure");
                expect((yield* first.pending)[0]).toMatchObject({
                    state: "acknowledged",
                    receipt: { operationId: "remote-operation" },
                    attempts: 1,
                });
                yield* Scope.close(scope, Exit.void);
                phase = "incomplete";
                const reopened = yield* makeReplica(settings);
                expect((yield* Effect.result(reopened.syncOnce))._tag).toBe("Failure");
                expect(yield* reopened.confirmed.get("Counter", "one")).toBeUndefined();
                expect((yield* reopened.pending)[0]).toMatchObject({ state: "acknowledged", attempts: 1 });
                phase = "ready";
                yield* reopened.syncOnce;
                expect(invocations).toBe(1);
                expect(yield* reopened.pending).toEqual([]);
                expect((yield* reopened.confirmed.get("Counter", "one"))?.count).toBe(2);
            })
        )
    );
});

test("a complete identity read-back can remove a deleted object without evicting unrelated rows", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let deleted = false;
                const rows = [
                    { key: "one", value: { id: "one", count: 1 } },
                    { key: "two", value: { id: "two", count: 2 } },
                ];
                const backend: OntologyBackendService = {
                    name: "test",
                    sourceId: "test",
                    supportsIdempotency: false,
                    loadSubset: (subset) =>
                        Effect.succeed({
                            rows: evaluateQuery(deleted ? [rows[1]!] : rows, subset.query),
                            complete: true,
                        }),
                    invoke: (invocation) =>
                        Effect.sync(() => {
                            deleted = true;
                            return {
                                invocationId: invocation.id,
                                outcome: "committed",
                                affected: [{ objectType: "Counter", keys: ["one"] }],
                            };
                        }),
                    queryFunction: () => Effect.succeed(undefined),
                };
                const replica = yield* makeReplica({
                    namespace: "deleted-receipt",
                    ir,
                    tables: yield* Memory.make(),
                    backend,
                    startSync: false,
                    outbox: { retryDelayMs: 0 },
                    execute: () => Effect.void,
                });
                const demand = yield* Scope.make();
                yield* Scope.provide(replica.demand({ objectType: "Counter" }), demand);
                yield* replica.syncOnce;
                yield* Scope.close(demand, Exit.void);
                yield* replica.enqueue({ id: "delete", name: "increment", parameters: {} });
                yield* replica.syncOnce;
                expect(yield* replica.get("Counter", "one")).toBeUndefined();
                expect((yield* replica.get("Counter", "two"))?.count).toBe(2);
            })
        )
    );
});

test("restart confirms a saved receipt before active demand can publish the remote edit twice", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                let remoteCount = 1;
                let fail = false;
                let invocations = 0;
                const reads: BackendSubset[] = [];
                const backend: OntologyBackendService = {
                    name: "test",
                    sourceId: "restart-demand",
                    supportsIdempotency: false,
                    loadSubset: (subset) =>
                        Effect.suspend(() => {
                            reads.push(subset);
                            return fail
                                ? Effect.fail(
                                      new BackendError({
                                          operation: "read",
                                          kind: "Unavailable",
                                          message: "Offline",
                                          retryable: true,
                                      })
                                  )
                                : Effect.succeed({
                                      complete: true,
                                      rows: [{ key: "one", value: { id: "one", count: remoteCount } }],
                                  });
                        }),
                    invoke: (invocation) =>
                        Effect.sync(() => {
                            invocations++;
                            remoteCount++;
                            fail = true;
                            return {
                                invocationId: invocation.id,
                                outcome: "committed",
                                affected: [{ objectType: "Counter", keys: ["one"] }],
                            };
                        }),
                    queryFunction: () => Effect.succeed(undefined),
                };
                let current: Effect.Success<ReturnType<typeof makeReplica>> | undefined;
                const published: unknown[] = [];
                const settings = {
                    namespace: "receipt-demand-restart",
                    ir,
                    tables,
                    backend,
                    startSync: false,
                    outbox: { retryDelayMs: 0 },
                    publish: Effect.gen(function* () {
                        if (current) published.push((yield* current.get("Counter", "one"))?.count);
                    }).pipe(Effect.orDie),
                    execute: (tx: import("@party-stack/ontology-backend/owned").OwnedTransaction) =>
                        Effect.gen(function* () {
                            const previous = yield* tx.get("Counter", "one");
                            yield* tx.put("Counter", { id: "one", count: Number(previous?.count ?? 0) + 1 });
                        }),
                };
                const scope = yield* Scope.make();
                const first = yield* Scope.provide(makeReplica(settings), scope);
                current = first;
                yield* Scope.provide(first.demand({ objectType: "Counter" }), scope);
                yield* first.syncOnce;
                yield* first.enqueue({ id: "once", name: "increment", parameters: {} });
                expect((yield* Effect.result(first.syncOnce))._tag).toBe("Failure");
                yield* Scope.close(scope, Exit.void);
                fail = false;
                current = undefined;
                const reopened = yield* makeReplica(settings);
                current = reopened;
                yield* reopened.demand({ objectType: "Counter" });
                published.length = 0;
                reads.length = 0;
                yield* reopened.syncOnce;
                expect(reads[0]?.query?.where).toEqual(inArray(field("id"), ["one"]));
                expect(published).not.toContain(3);
                expect(published.every((count) => count === 2)).toBe(true);
                expect(invocations).toBe(1);
                expect((yield* reopened.get("Counter", "one"))?.count).toBe(2);
            })
        )
    );
});

test.each([false, true])(
    "interrupted dispatch preserves its attempt and recovers according to idempotency (%s)",
    async (supportsIdempotency) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const tables = yield* Memory.make();
                    const entered = yield* Deferred.make<void>();
                    let calls = 0;
                    let hold = true;
                    const backend: OntologyBackendService = {
                        name: "interrupted",
                        sourceId: "interrupted",
                        supportsIdempotency,
                        queryFunction: () => Effect.void,
                        loadSubset: () => Effect.succeed({ complete: true, rows: [] }),
                        invoke: (invocation) =>
                            Effect.gen(function* () {
                                calls++;
                                yield* Deferred.succeed(entered, undefined);
                                if (hold) yield* Effect.never;
                                return { invocationId: invocation.id, outcome: "accepted" as const };
                            }),
                    };
                    const options = {
                        namespace: "interrupted-dispatch",
                        ir,
                        tables,
                        backend,
                        execute: () => Effect.void,
                        startSync: false,
                        outbox: { retryDelayMs: 0 },
                        gc: false as const,
                    };
                    const firstScope = yield* Scope.make();
                    const first = yield* Scope.provide(makeReplica(options), firstScope);
                    yield* first.enqueue({ id: "once", name: "increment", parameters: {} });
                    const dispatch = yield* Effect.forkChild(first.syncOnce);
                    yield* Deferred.await(entered);
                    expect((yield* first.pending)[0]).toMatchObject({ state: "sending", attempts: 1 });
                    yield* Fiber.interrupt(dispatch);
                    yield* Scope.close(firstScope, Exit.void);
                    hold = false;
                    const reopened = yield* makeReplica(options);
                    yield* reopened.syncOnce;
                    expect((yield* reopened.pending)[0]).toMatchObject({
                        state: supportsIdempotency ? "acknowledged" : "uncertain",
                        attempts: supportsIdempotency ? 2 : 1,
                    });
                    yield* reopened.syncOnce;
                    expect(calls).toBe(supportsIdempotency ? 2 : 1);
                    expect((yield* reopened.pending)[0]?.attempts).toBe(calls);
                })
            )
        );
    }
);

test("retry attempts advance once per submission, and acceptance never resets or resubmits them", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let calls = 0;
                const replica = yield* makeReplica({
                    namespace: "retry-attempts",
                    ir,
                    tables: yield* Memory.make(),
                    startSync: false,
                    outbox: { retryDelayMs: 0 },
                    gc: false,
                    execute: () => Effect.void,
                    backend: {
                        name: "retry",
                        sourceId: "retry",
                        supportsIdempotency: true,
                        queryFunction: () => Effect.void,
                        loadSubset: () => Effect.succeed({ complete: true, rows: [] }),
                        invoke: (invocation) =>
                            Effect.suspend(() => {
                                calls++;
                                return calls === 1
                                    ? Effect.fail(
                                          new BackendError({
                                              operation: "invoke",
                                              kind: "Unavailable",
                                              message: "Try again",
                                              retryable: true,
                                          })
                                      )
                                    : Effect.succeed({
                                          invocationId: invocation.id,
                                          outcome: "accepted" as const,
                                      });
                            }),
                    },
                });
                yield* replica.enqueue({ id: "once", name: "increment", parameters: {} });
                expect((yield* Effect.result(replica.syncOnce))._tag).toBe("Failure");
                expect((yield* replica.pending)[0]).toMatchObject({ state: "queued", attempts: 1 });
                yield* replica.syncOnce;
                expect((yield* replica.pending)[0]).toMatchObject({
                    state: "acknowledged",
                    attempts: 2,
                    receipt: { outcome: "accepted" },
                });
                yield* replica.syncOnce;
                expect(calls).toBe(2);
                expect((yield* replica.pending)[0]?.attempts).toBe(2);
                expect((yield* replica.pending)[0]?.failure).toBeUndefined();
            })
        )
    );
});
