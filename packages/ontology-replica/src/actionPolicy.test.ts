import { BackendError, type OntologyBackendService } from "@party-stack/ontology-backend";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect, Exit, Fiber, Scope } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { makeReplica, replicaStateSource } from "./index.js";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [],
    actionTypes: [
        {
            name: "write",
            displayName: "Write",
            logic: [],
            parameters: [{ name: "value", displayName: "Value", type: o.string({}) }],
        },
    ],
};
const invocation = (id: string) => ({ id, name: "write", parameters: { value: id } });
const fail = (kind: "Unavailable" | "Rejected" = "Unavailable") =>
    new BackendError({
        operation: "test",
        kind,
        message: "An actual failure message",
        retryable: kind === "Unavailable",
    });
const backend = (invoke: OntologyBackendService["invoke"], idempotent = true): OntologyBackendService => ({
    name: "test",
    sourceId: "test",
    supportsIdempotency: idempotent,
    invoke,
    loadSubset: () => Effect.succeed({ rows: [], complete: true }),
    queryFunction: () => Effect.void,
});

test("retry deadline and budget survive reopening; explicit retry resets budget, not total attempts", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                let calls = 0;
                const remote = backend(() =>
                    Effect.suspend(() => {
                        calls++;
                        return Effect.fail(fail());
                    })
                );
                const options = {
                    namespace: "retry",
                    tables,
                    ir,
                    backend: remote,
                    startSync: false,
                    gc: false as const,
                    execute: () => Effect.void,
                    outbox: { maxRetries: 1, retryDelayMs: 1_000 },
                };
                const scope = yield* Scope.make();
                const first = yield* Scope.provide(makeReplica(options), scope);
                yield* first.enqueue(invocation("one"));
                yield* Effect.result(first.syncOnce);
                expect((yield* first.pending)[0]).toMatchObject({
                    state: "queued",
                    attempts: 1,
                    nextAttemptAt: 1_000,
                    failureMessage: "An actual failure message",
                });
                yield* Scope.close(scope, Exit.void);
                const reopened = yield* makeReplica(options);
                yield* reopened.syncOnce;
                expect(calls).toBe(1);
                yield* TestClock.adjust(999);
                yield* reopened.syncOnce;
                expect(calls).toBe(1);
                yield* TestClock.adjust(1);
                yield* Effect.result(reopened.syncOnce);
                expect((yield* reopened.pending)[0]).toMatchObject({ state: "blocked", attempts: 2 });
                yield* TestClock.adjust(60_000);
                yield* reopened.syncOnce;
                expect(calls).toBe(2);
                yield* reopened.retry("one");
                yield* Effect.result(reopened.syncOnce);
                expect((yield* reopened.pending)[0]).toMatchObject({
                    state: "queued",
                    attempts: 3,
                    retryFromAttempt: 2,
                });
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});

test("discard-all abandons the queue for both definite failures and unknown outcomes", async () => {
    for (const kind of ["Rejected", "Unavailable"] as const) {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const replica = yield* makeReplica({
                        namespace: kind,
                        ir,
                        tables: yield* Memory.make(),
                        backend: backend(() => Effect.fail(fail(kind)), false),
                        execute: () => Effect.void,
                        startSync: false,
                        outbox: { maxRetries: 0, failureStrategy: "discard-all" },
                    });
                    yield* replica.enqueue(invocation("one"));
                    yield* replica.enqueue(invocation("two"));
                    yield* Effect.result(replica.syncOnce);
                    expect(yield* replica.pending).toEqual([]);
                })
            )
        );
    }
});

test("pause preserves uncertain intent until a verified receipt is reconciled", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const replica = yield* makeReplica({
                    namespace: "uncertain",
                    ir,
                    tables: yield* Memory.make(),
                    backend: backend(() => Effect.fail(fail()), false),
                    execute: () => Effect.void,
                    startSync: false,
                });
                yield* replica.enqueue(invocation("one"));
                yield* Effect.result(replica.syncOnce);
                expect((yield* replica.pending)[0]?.state).toBe("uncertain");
                expect((yield* Effect.result(replica.retry("one")))._tag).toBe("Failure");
                expect((yield* Effect.result(replica.remove("one")))._tag).toBe("Failure");
                yield* replica.reconcile("one", { invocationId: "one", outcome: "committed", affected: [] });
                yield* replica.syncOnce;
                expect((yield* replica.receipt("one"))?.outcome).toBe("committed");
            })
        )
    );
});

test("acceptance and confirmation waits differ; interrupting a wait leaves durable intent intact", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const parent = yield* makeReplica({
                    namespace: "parent",
                    ir,
                    tables: yield* Memory.make(),
                    backend: backend((a) =>
                        Effect.succeed({ invocationId: a.id, outcome: "committed", affected: [] })
                    ),
                    execute: () => Effect.void,
                    startSync: false,
                });
                const child = yield* makeReplica({
                    namespace: "child",
                    ir,
                    tables: yield* Memory.make(),
                    source: replicaStateSource(parent),
                    execute: () => Effect.void,
                    startSync: false,
                    gc: false,
                });
                yield* child.enqueue(invocation("one"));
                const waiting = yield* Effect.forkScoped(child.awaitAction("one"));
                yield* child.syncOnce;
                expect(yield* child.awaitAction("one", { until: "accepted" })).toBeUndefined();
                expect(waiting.pollUnsafe()).toBeUndefined();
                yield* Fiber.interrupt(waiting);
                expect((yield* parent.pending).map((a) => a.invocation.id)).toEqual(["one"]);
                yield* parent.syncOnce;
                yield* child.syncOnce;
                expect((yield* child.awaitAction("one"))?.outcome).toBe("committed");
            })
        )
    );
});

test("local receipt application can fail and restart without losing the receipt or dispatching again", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                let submissions = 0;
                let failMapping = true;
                const options = {
                    namespace: "receipt-local",
                    ir,
                    tables,
                    startSync: false,
                    execute: () => Effect.void,
                    backend: backend(
                        (action) =>
                            Effect.sync(() => {
                                submissions++;
                                return {
                                    invocationId: action.id,
                                    outcome: "committed" as const,
                                    affected: [],
                                    attachmentIdMappings: [{ localId: "local", remoteId: "remote" }],
                                };
                            }),
                        false
                    ),
                    onReceipt: () => (failMapping ? Effect.fail(fail()) : Effect.void),
                };
                const scope = yield* Scope.make();
                const first = yield* Scope.provide(makeReplica(options), scope);
                yield* first.enqueue(invocation("one"));
                yield* Effect.result(first.syncOnce);
                expect((yield* first.pending)[0]).toMatchObject({
                    state: "acknowledged",
                    receipt: { outcome: "committed" },
                });
                yield* Scope.close(scope, Exit.void);
                failMapping = false;
                const reopened = yield* makeReplica(options);
                yield* reopened.syncOnce;
                expect(submissions).toBe(1);
                expect(yield* reopened.pending).toEqual([]);
                expect((yield* reopened.awaitAction("one"))?.outcome).toBe("committed");
            })
        )
    );
});

test("an explicit pre-dispatch failure permits automatic retry without backend idempotency", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let attempts = 0;
                const replica = yield* makeReplica({
                    namespace: "preflight",
                    ir,
                    tables: yield* Memory.make(),
                    startSync: false,
                    execute: () => Effect.void,
                    outbox: { retryDelayMs: 0 },
                    backend: backend(
                        (action) =>
                            Effect.suspend(() => {
                                attempts++;
                                return attempts === 1
                                    ? Effect.fail(
                                          new BackendError({
                                              operation: "prepare",
                                              kind: "Unavailable",
                                              message: "Attachment upload unavailable",
                                              retryable: true,
                                              invocationOutcome: "not-committed",
                                          })
                                      )
                                    : Effect.succeed({
                                          invocationId: action.id,
                                          outcome: "committed",
                                          affected: [],
                                      });
                            }),
                        false
                    ),
                });
                yield* replica.enqueue(invocation("one"));
                yield* Effect.result(replica.syncOnce);
                expect((yield* replica.pending)[0]?.state).toBe("queued");
                yield* replica.syncOnce;
                expect(attempts).toBe(2);
                expect(yield* replica.pending).toEqual([]);
            })
        )
    );
});
