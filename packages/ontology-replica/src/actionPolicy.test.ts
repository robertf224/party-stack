import { it } from "@effect/vitest";
import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { BackendError, type OntologyBackendService } from "@party-stack/ontology-backend";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { makeReplica as makePublicReplica } from "./service.js";
import { makeReplica, replicaStateSource } from "./testing.js";

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
const fail = (kind: "Unavailable" | "ValidationFailed" = "Unavailable") =>
    new BackendError({
        operation: "test",
        kind,
        message: "An actual failure message",
        retryable: kind === "Unavailable",
    });
const backend = (
    applyAction: OntologyBackendService["applyAction"],
    idempotent = true
): OntologyBackendService =>
    makeOntologyBackend({
        ir,
        name: "test",
        sourceId: "test",
        supportsIdempotency: idempotent,
        applyAction,
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
                    objectCacheGc: false as const,
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
    for (const kind of ["ValidationFailed", "Unavailable"] as const) {
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

test("pause preserves unknown-outcome intent until a verified receipt is reconciled", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const replica = yield* makeReplica({
                    namespace: "blocked",
                    ir,
                    tables: yield* Memory.make(),
                    backend: backend(() => Effect.fail(fail()), false),
                    execute: () => Effect.void,
                    startSync: false,
                });
                yield* replica.enqueue(invocation("one"));
                yield* Effect.result(replica.syncOnce);
                expect((yield* replica.pending)[0]?.state).toBe("blocked");
                expect((yield* Effect.result(replica.retry("one")))._tag).toBe("Failure");
                expect((yield* Effect.result(replica.remove("one")))._tag).toBe("Failure");
                yield* replica.reconcile("one", { operationId: "one", outcome: "committed", affected: [] });
                yield* replica.syncOnce;
                expect((yield* replica.receipt("one"))?.outcome).toBe("committed");
            })
        )
    );
});

test("discarded rejection results deliver errors without retaining intent and expire with result retention", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let calls = 0;
                const replica = yield* makeReplica({
                    namespace: "discarded-results",
                    ir,
                    tables: yield* Memory.make(),
                    backend: backend(() => {
                        calls++;
                        return Effect.fail(fail("ValidationFailed"));
                    }),
                    execute: () => Effect.void,
                    startSync: false,
                    outbox: { failureStrategy: "discard-all" },
                    resultRetentionMs: 100,
                });
                yield* replica.enqueue(invocation("one"));
                yield* replica.enqueue(invocation("two"));
                yield* Effect.result(replica.syncOnce);
                expect(yield* replica.pendingActions).toEqual([]);
                expect((yield* replica.actionStatus("one")).error?.kind).toBe("ValidationFailed");
                expect((yield* replica.actionStatus("two")).error?.kind).toBe("Conflict");
                expect(calls).toBe(1);
                yield* TestClock.adjust(101);
                yield* replica.syncOnce;
                expect((yield* replica.actionStatus("one")).error).toBeUndefined();
                expect((yield* replica.actionStatus("two")).error).toBeUndefined();
                expect(calls).toBe(1);
            })
        ).pipe(Effect.provide(TestClock.layer()))
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
                        Effect.succeed({ operationId: a.id, outcome: "committed", affected: [] })
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
                    objectCacheGc: false,
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
                                    operationId: action.id,
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
                                              actionOutcome: "not-committed",
                                          })
                                      )
                                    : Effect.succeed({
                                          operationId: action.id,
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

test("a rejected retry does not erase an earlier unknown outcome", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let calls = 0;
                const replica = yield* makeReplica({
                    namespace: "unknown-retry",
                    ir,
                    tables: yield* Memory.make(),
                    backend: backend(() =>
                        Effect.fail(
                            ++calls === 1
                                ? fail()
                                : new BackendError({
                                      operation: "applyAction",
                                      kind: "SessionExpired",
                                      message: "Expired",
                                      retryable: false,
                                      actionOutcome: "not-committed",
                                  })
                        )
                    ),
                    execute: () => Effect.void,
                    startSync: false,
                    outbox: { maxRetries: 1, retryDelayMs: 100 },
                });
                yield* replica.enqueue(invocation("one"));
                yield* Effect.result(replica.syncOnce);
                yield* TestClock.adjust(101);
                yield* Effect.result(replica.syncOnce);
                expect((yield* replica.pending)[0]).toMatchObject({
                    state: "blocked",
                    attempts: 2,
                    failureOutcome: "unknown",
                });
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});

test("protected pending receipts cannot starve expired journal-hint cleanup", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const namespace = "hint-cleanup";
                const replica = yield* makeReplica({
                    namespace,
                    ir,
                    tables,
                    backend: backend(() => Effect.die("offline")),
                    execute: () => Effect.void,
                    startSync: false,
                    connectivity: { online: Effect.succeed(false), changes: Stream.never },
                    resultRetentionMs: 100,
                });
                const hints = Table.make({
                    name: JSON.stringify(["replica", namespace, "journal-receipts"]),
                });
                for (let index = 0; index < 100; index++) {
                    const id = `pending-${index}`;
                    yield* replica.enqueue(invocation(id));
                    yield* tables.put(hints, id, { operationId: id, outcome: "committed", observedAt: 0 });
                }
                yield* tables.put(hints, "zz-orphan", {
                    operationId: "zz-orphan",
                    outcome: "committed",
                    observedAt: 0,
                });
                yield* TestClock.adjust(101);
                yield* replica.syncOnce;
                expect(yield* tables.get(hints, "zz-orphan")).toBeUndefined();
                expect(yield* tables.query(hints)).toHaveLength(100);
                expect(yield* replica.pending).toHaveLength(100);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});

test("unknown outcome is separate from pause and explicit retry/discard acknowledgment", async () => {
    for (const idempotent of [true, false])
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const replica = yield* makeReplica({
                        namespace: `unknown-${idempotent}`,
                        ir,
                        tables: yield* Memory.make(),
                        backend: backend(() => Effect.fail(fail()), idempotent),
                        execute: () => Effect.void,
                        startSync: false,
                    });
                    yield* replica.enqueue(invocation("one"));
                    yield* Effect.result(replica.syncOnce);
                    expect((yield* replica.pending)[0]).toMatchObject({
                        state: idempotent ? "queued" : "blocked",
                        failureOutcome: "unknown",
                        retryRequiresAcknowledgement: !idempotent,
                    });
                    if (!idempotent) {
                        expect((yield* Effect.result(replica.retry("one")))._tag).toBe("Failure");
                        yield* replica.retry("one", { allowUnknownOutcome: true });
                        expect((yield* replica.pending)[0]?.state).toBe("queued");
                    }
                    expect((yield* Effect.result(replica.remove("one")))._tag).toBe("Failure");
                    yield* replica.remove("one", { allowUnknownOutcome: true });
                    expect(yield* replica.pending).toEqual([]);
                })
            )
        );
});

test("a wait behind a blocked action fails naming it, and the action is sent once the block is resolved", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const sent: string[] = [];
                const replica = yield* makeReplica({
                    namespace: "blocked-ahead",
                    ir,
                    tables: yield* Memory.make(),
                    // The first dispatch's outcome is unknown and cannot be deduplicated.
                    backend: backend(
                        (action) =>
                            Effect.suspend(() => {
                                sent.push(action.id);
                                return action.id === "one"
                                    ? Effect.fail(fail())
                                    : Effect.succeed({
                                          operationId: action.id,
                                          outcome: "committed" as const,
                                          affected: [],
                                      });
                            }),
                        false
                    ),
                    execute: () => Effect.void,
                    startSync: false,
                });
                yield* replica.enqueue(invocation("one"));
                yield* replica.enqueue(invocation("two"));
                // A wait already under way ends when the block happens.
                const waiting = yield* Effect.forkScoped(replica.awaitAction("two"));
                yield* Effect.result(replica.syncOnce);
                const behind = yield* Effect.flip(Fiber.join(waiting));
                expect(behind).toMatchObject({
                    kind: "Conflict",
                    retryable: false,
                    blockedBy: { id: "one", name: "write", failure: "Unavailable" },
                });
                expect(behind.actionOutcome).toBeUndefined();
                // The blocked action's own wait reports its own failure, not a block ahead.
                const own = yield* Effect.flip(replica.awaitAction("one"));
                expect(own.blockedBy).toBeUndefined();
                expect(own.actionOutcome).toBe("unknown");
                // A wait started later ends at once, and the action keeps its place.
                yield* replica.enqueue(invocation("three"));
                expect((yield* Effect.flip(replica.awaitAction("three"))).blockedBy?.id).toBe("one");
                expect((yield* replica.pending).map((a) => [a.invocation.id, a.state])).toEqual([
                    ["one", "blocked"],
                    ["two", "queued"],
                    ["three", "queued"],
                ]);
                expect(sent).toEqual(["one"]);
                yield* replica.reconcile("one", { operationId: "one", outcome: "committed", affected: [] });
                yield* replica.syncOnce;
                expect((yield* replica.awaitAction("two"))?.outcome).toBe("committed");
                expect((yield* replica.awaitAction("three"))?.outcome).toBe("committed");
                expect(sent).toEqual(["one", "two", "three"]);
            })
        )
    );
});

test.each(["snapshot", "delivery"] as const)(
    "a child observes a queue block through a selected %s",
    async (mode) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const parent = yield* makeReplica({
                        namespace: "parent-blocked",
                        ir,
                        tables: yield* Memory.make(),
                        backend: backend(
                            (action) =>
                                action.id === "one"
                                    ? Effect.fail(fail())
                                    : Effect.succeed({
                                          operationId: action.id,
                                          outcome: "committed",
                                          affected: [],
                                      }),
                            false
                        ),
                        execute: () => Effect.void,
                        startSync: false,
                    });
                    const source = replicaStateSource(parent);
                    const child = yield* makeReplica({
                        namespace: "child-blocked",
                        ir,
                        tables: yield* Memory.make(),
                        source,
                        execute: () => Effect.void,
                        startSync: false,
                        objectCacheGc: false,
                    });
                    // Simulate a different tab submitting the first action.
                    yield* parent.enqueue(invocation("one"));
                    yield* child.enqueue(invocation("two"));
                    yield* child.syncOnce;
                    yield* Effect.result(parent.syncOnce);
                    if (mode === "snapshot") yield* child.refreshParent(source);
                    else {
                        const opened = yield* child.openParentDelivery(source);
                        yield* opened.subscription.frames.pipe(
                            Stream.takeUntil((frame) => frame.end),
                            Stream.runForEach((frame) => child.receiveDelivery(frame, opened.generation))
                        );
                    }
                    expect((yield* child.parentState)?.pending.map((entry) => entry.invocation.id)).toEqual([
                        "two",
                    ]);
                    const hidden = yield* Effect.flip(child.awaitAction("two"));
                    expect(hidden.kind).toBe("Conflict");
                    expect(hidden.blockedBy).toBeUndefined();
                    expect(yield* child.awaitAction("two", { until: "accepted" })).toBeUndefined();

                    yield* child.retainActions(["one"]);
                    yield* child.refreshParent(source);
                    expect((yield* Effect.flip(child.awaitAction("two"))).blockedBy).toEqual({
                        id: "one",
                        name: "write",
                        failure: "Unavailable",
                    });
                    expect((yield* parent.pending).map((a) => [a.invocation.id, a.state])).toEqual([
                        ["one", "blocked"],
                        ["two", "queued"],
                    ]);
                })
            )
        );
    }
);

test("a dispatch that never answers times out as an unknown outcome", async () => {
    for (const idempotent of [false, true]) {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    let calls = 0;
                    const replica = yield* makeReplica({
                        namespace: `dispatch-timeout-${idempotent}`,
                        ir,
                        tables: yield* Memory.make(),
                        // The first dispatch hangs; a resend answers.
                        backend: backend(
                            (action) =>
                                Effect.suspend(() =>
                                    ++calls === 1
                                        ? Effect.never
                                        : Effect.succeed({
                                              operationId: action.id,
                                              outcome: "committed" as const,
                                              affected: [],
                                          })
                                ),
                            idempotent
                        ),
                        execute: () => Effect.void,
                        startSync: false,
                        outbox: { dispatchTimeoutMs: 5_000 },
                    });
                    yield* replica.enqueue(invocation("one"));
                    const pass = yield* Effect.forkScoped(Effect.result(replica.syncOnce));
                    while (calls === 0) yield* Effect.yieldNow;
                    yield* TestClock.adjust(4_999);
                    expect(pass.pollUnsafe()).toBeUndefined();
                    yield* TestClock.adjust(1);
                    const result = yield* Fiber.join(pass);
                    expect(result._tag).toBe("Failure");
                    if (result._tag === "Failure")
                        expect(result.failure).toMatchObject({
                            kind: "Unavailable",
                            actionOutcome: "unknown",
                        });
                    expect((yield* replica.pending)[0]).toMatchObject({
                        state: idempotent ? "queued" : "blocked",
                        failureOutcome: "unknown",
                        retryRequiresAcknowledgement: !idempotent,
                    });
                    if (!idempotent) return;
                    yield* TestClock.adjust(1_000);
                    yield* replica.syncOnce;
                    expect(calls).toBe(2);
                    expect((yield* replica.receipt("one"))?.outcome).toBe("committed");
                })
            ).pipe(Effect.provide(TestClock.layer()))
        );
    }
});

it.effect("invalid dispatch deadlines fail when opening the replica", () =>
    Effect.gen(function* () {
        for (const dispatchTimeoutMs of [0, -1, NaN, -Infinity]) {
            const error = yield* Effect.flip(
                makeReplica({
                    namespace: "dispatch-timeout-invalid",
                    ir,
                    tables: yield* Memory.make(),
                    backend: backend(() => Effect.never),
                    execute: () => Effect.void,
                    startSync: false,
                    outbox: { dispatchTimeoutMs },
                })
            );
            expect(error.kind).toBe("InvalidConfiguration");
        }
    })
);

it.effect(
    "the public outbox applies its configured timeout and discard policy, including the Infinity opt-out",
    () =>
        Effect.gen(function* () {
            for (const dispatchTimeoutMs of [1_000, Infinity]) {
                const started = yield* Deferred.make<void>();
                const release = yield* Deferred.make<void>();
                const sent: string[] = [];
                const replica = yield* makePublicReplica({
                    namespace: "public-dispatch-timeout",
                    ir,
                    tables: yield* Memory.make(),
                    outbox: { dispatchTimeoutMs, failureStrategy: "discard-all" },
                    backend: backend(
                        (request) =>
                            Effect.gen(function* () {
                                sent.push(request.id);
                                yield* Deferred.succeed(started, undefined);
                                yield* Deferred.await(release);
                                return {
                                    operationId: request.id,
                                    outcome: "committed" as const,
                                    affected: [],
                                };
                            }),
                        false
                    ),
                });
                const first = yield* Effect.forkScoped(replica.actions.apply(invocation("one")));
                yield* Deferred.await(started);
                yield* replica.outbox.enqueue(invocation("two"));
                if (dispatchTimeoutMs === Infinity) {
                    yield* TestClock.adjust(60_000);
                    expect(first.pollUnsafe()).toBeUndefined();
                    yield* Deferred.succeed(release, undefined);
                    expect((yield* Fiber.join(first)).outcome).toBe("committed");
                    expect((yield* replica.outbox.wait("two"))?.outcome).toBe("committed");
                    expect(sent).toEqual(["one", "two"]);
                } else {
                    yield* TestClock.adjust(dispatchTimeoutMs);
                    expect(yield* Effect.flip(Fiber.join(first))).toMatchObject({
                        kind: "Unavailable",
                        actionOutcome: "unknown",
                    });
                    expect(yield* Effect.flip(replica.outbox.wait("two"))).toMatchObject({
                        kind: "Conflict",
                        actionOutcome: "not-committed",
                    });
                    expect(sent).toEqual(["one"]);
                }
                expect(yield* replica.outbox.entries).toEqual([]);
            }
        })
);
