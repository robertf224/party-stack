import { BackendError } from "@party-stack/ontology-backend";
import { Clock, Effect, Queue, Ref, Stream } from "effect";
import { deliveryRecovery } from "./recovery.js";
import type { ReplicaService } from "./index.js";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";

/** The parent's storage determines whether acceptance survives process exit.
 * A memory parent's acceptance is not a persistent durability guarantee.
 */
export const replicaStateSource = (parent: ReplicaService): OntologySource => ({
    sourceId: parent.sourceId,
    supportsIdempotency: true,
    openClient: parent.openClient,
    read: parent.readClient,
    subscribe: parent.subscribeClient,
    accept: parent.acceptClient,
    acknowledgeDelivery: parent.acknowledgeDelivery,
    demand: (subset) => parent.demand(subset).pipe(Effect.andThen(parent.syncSubset(subset))),
    subscribeChanges: parent.subscribeChanges,
    submit: parent.submitClient,
    acknowledge: parent.acknowledgeClient,
});

/** Selected delivery has one installer. Local selection changes cancel its Scope
 * and start a new snapshot; ordinary row changes keep the same stream alive.
 */
export const connectReplicaDelivery = Effect.fn("Replica.connectDelivery")(function* (
    child: ReplicaService,
    source?: OntologySource,
    options?: { readonly retryIntervalMs?: number; readonly heartbeatIntervalMs?: number }
) {
    const retry = options?.retryIntervalMs ?? 1_000;
    const heartbeat = options?.heartbeatIntervalMs ?? 60_000;
    const error = yield* Ref.make<BackendError | undefined>(undefined);
    const selectionWake = yield* Queue.sliding<void>(1);
    const actionWake = yield* Queue.sliding<void>(1);
    const changes = yield* child.subscribeChanges;
    yield* Stream.runForEach(changes, () =>
        Queue.offer(selectionWake, undefined).pipe(Effect.andThen(Queue.offer(actionWake, undefined)))
    ).pipe(Effect.forkScoped);
    yield* Effect.forkScoped(
        Effect.gen(function* () {
            const span = yield* Effect.currentSpan;
            for (;;) {
                const result = yield* Effect.result(
                    Effect.scoped(
                        Effect.gen(function* () {
                            const opened = yield* child.openParentDelivery(source);
                            span.event("replica.subscribed", yield* Clock.currentTimeNanos, {
                                generation: opened.generation,
                            });
                            let changes = 0;
                            const consume = Stream.runForEach(opened.subscription.frames, (frame) =>
                                Effect.gen(function* () {
                                    if (frame.part === 0) changes = 0;
                                    changes += frame.changes.length;
                                    const installed = yield* child.receiveDelivery(frame);
                                    if (!installed) return;
                                    span.event("replica.applied", yield* Clock.currentTimeNanos, {
                                        sequence: installed.position.sequence,
                                        changes,
                                        kind: frame.kind,
                                    });
                                    yield* Ref.set(error, undefined);
                                    yield* child.reportReplicationFailure();
                                    const meta = installed.metadata;
                                    if (source && meta.client)
                                        yield* source.acknowledge(
                                            meta.client,
                                            meta.revision,
                                            meta.client.deliveredThrough,
                                            meta.generation
                                        );
                                    yield* opened.subscription.acknowledge(installed.position);
                                })
                            );
                            const changed = Effect.gen(function* () {
                                for (;;) {
                                    yield* Queue.take(selectionWake);
                                    if ((yield* child.parentDeliveryGeneration) !== opened.generation)
                                        return yield* new BackendError({
                                            operation: "delivery.selection",
                                            kind: "ViewReplaced",
                                            retryable: true,
                                            message: "Selection changed.",
                                        });
                                }
                            });
                            yield* Effect.raceFirst(consume, changed);
                        })
                    )
                );
                if (result._tag === "Failure") {
                    const recovery = deliveryRecovery(result.failure);
                    span.event("replica.disconnected", yield* Clock.currentTimeNanos, {
                        kind: result.failure.kind,
                        recovery,
                    });
                    if (recovery === "selection") continue;
                    yield* Ref.set(error, result.failure);
                    yield* child.reportReplicationFailure(result.failure);
                    if (source && recovery === "session")
                        yield* child
                            .refreshParent(source)
                            .pipe(Effect.catch((failure) => Ref.set(error, failure)));
                    else if (recovery === "stop") return;
                }
                yield* Effect.sleep(retry);
            }
        }).pipe(
            Effect.withSpan("Replica.delivery", { root: true, attributes: { activity: "subscription" } })
        ),
        { startImmediately: true }
    );
    const syncOnce = source ? child.syncParent(source) : child.syncOnce;
    if (source)
        yield* Effect.forkScoped(
            Effect.gen(function* () {
                for (;;) {
                    if ((yield* child.pending).length)
                        yield* syncOnce.pipe(Effect.catch((failure) => Ref.set(error, failure)));
                    const head = (yield* child.pending)[0];
                    const now = yield* Clock.currentTimeMillis;
                    const delay =
                        head?.state === "queued" && head.nextAttemptAt !== undefined
                            ? Math.min(heartbeat, Math.max(1, head.nextAttemptAt - now))
                            : heartbeat;
                    yield* Effect.raceFirst(Queue.take(actionWake), Effect.sleep(delay));
                }
            }),
            { startImmediately: true }
        );
    return { syncOnce, lastError: Ref.get(error) } satisfies ParentConnection;
});

export interface ParentConnection {
    readonly syncOnce: Effect.Effect<void, BackendError>;
    readonly lastError: Effect.Effect<BackendError | undefined>;
}

/** One scoped connection, not another Replica engine. Subscriptions are acquired
 * before the initial snapshot. Closing the scope stops transfer without removing
 * work already accepted by the parent or locally retained for a later retry.
 */
export const connectReplicaParent = Effect.fn("Replica.connectParent")(function* (
    child: ReplicaService,
    source: OntologySource,
    options?: { readonly retryIntervalMs?: number; readonly heartbeatIntervalMs?: number }
) {
    const retryIntervalMs = options?.retryIntervalMs ?? 1_000;
    const heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 60_000;
    if (
        !Number.isFinite(retryIntervalMs) ||
        retryIntervalMs < 1 ||
        !Number.isFinite(heartbeatIntervalMs) ||
        heartbeatIntervalMs < 1
    )
        return yield* new BackendError({
            operation: "replica.connectParent",
            kind: "InvalidConfiguration",
            message: "Parent retry and heartbeat intervals must be positive numbers.",
            retryable: false,
        });
    const error = yield* Ref.make<BackendError | undefined>(undefined);
    const parentChanges = yield* Effect.result(source.subscribeChanges);
    if (parentChanges._tag === "Failure") {
        if (!parentChanges.failure.retryable) return yield* parentChanges.failure;
        yield* Ref.set(error, parentChanges.failure);
    }
    const childChanges = yield* child.subscribeChanges;
    const initial = yield* Effect.result(child.refreshParent(source));
    if (initial._tag === "Failure") {
        if (!initial.failure.retryable) return yield* initial.failure;
        yield* Ref.set(error, initial.failure);
    }
    const queue = yield* Queue.sliding<void>(1);
    const actionQueue = yield* Queue.sliding<void>(1);
    let closed = false;
    yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
            closed = true;
        }).pipe(Effect.andThen(Queue.shutdown(queue)), Effect.andThen(Queue.shutdown(actionQueue)))
    );
    const wake = Queue.offer(queue, undefined).pipe(Effect.asVoid);
    const syncOnce = Effect.suspend(() =>
        closed
            ? Effect.fail(
                  new BackendError({
                      operation: "replica.connectParent",
                      kind: "Unavailable",
                      retryable: false,
                      message: "Parent connection is closed.",
                  })
              )
            : child.syncParent(source)
    ).pipe(
        Effect.tap(() =>
            Effect.gen(function* () {
                if (!(yield* child.pending)[0]?.failure) yield* Ref.set(error, undefined);
            })
        ),
        Effect.tapError((failure) => Ref.set(error, failure))
    );
    yield* Effect.forkScoped(
        Effect.gen(function* () {
            const span = yield* Effect.currentSpan;
            let first = true;
            for (;;) {
                const existing =
                    first && parentChanges._tag === "Success" ? parentChanges.success : undefined;
                first = false;
                const result = yield* Effect.result(
                    Effect.scoped(
                        Effect.gen(function* () {
                            const changes = existing ?? (yield* source.subscribeChanges);
                            span.event("replica.subscribed", yield* Clock.currentTimeNanos);
                            // Refresh after every acquisition: events during a gap are not replayable hints.
                            yield* wake;
                            yield* Stream.runForEach(changes, () =>
                                Effect.gen(function* () {
                                    span.event("replica.invalidation", yield* Clock.currentTimeNanos);
                                    yield* wake;
                                })
                            );
                        })
                    )
                );
                span.event("replica.disconnected", yield* Clock.currentTimeNanos);
                if (result._tag === "Failure") {
                    yield* Ref.set(error, result.failure);
                    if (!result.failure.retryable) return;
                }
                yield* wake;
                yield* Effect.sleep(retryIntervalMs);
            }
        }).pipe(
            Effect.withSpan("Replica.watchParent", { root: true, attributes: { activity: "subscription" } })
        ),
        { startImmediately: true }
    );
    yield* Effect.forkScoped(
        Stream.runForEach(childChanges, () => wake.pipe(Effect.andThen(Queue.offer(actionQueue, undefined)))),
        { startImmediately: true }
    );
    yield* Effect.forkScoped(
        Effect.gen(function* () {
            for (;;) {
                yield* Effect.raceFirst(Queue.take(queue), Effect.sleep(heartbeatIntervalMs));
                const result = yield* Effect.result(child.refreshParent(source));
                if (result._tag === "Failure") {
                    yield* Ref.set(error, result.failure);
                    if (result.failure.retryable) {
                        yield* Effect.sleep(retryIntervalMs);
                        yield* wake;
                    }
                }
            }
        }),
        { startImmediately: true }
    );
    yield* Effect.forkScoped(
        Effect.gen(function* () {
            for (;;) {
                const head = (yield* child.pending)[0];
                const now = yield* Clock.currentTimeMillis;
                const delay =
                    head?.state === "queued" && head.nextAttemptAt !== undefined
                        ? Math.min(heartbeatIntervalMs, Math.max(1, head.nextAttemptAt - now))
                        : heartbeatIntervalMs;
                yield* Effect.raceFirst(Queue.take(actionQueue), Effect.sleep(delay));
                if (!(yield* child.pending).length) continue;
                const result = yield* Effect.result(syncOnce);
                if (result._tag === "Failure" && result.failure.retryable) {
                    yield* Effect.sleep(retryIntervalMs);
                    yield* Queue.offer(actionQueue, undefined);
                }
            }
        }),
        { startImmediately: true }
    );
    yield* Queue.offer(actionQueue, undefined);
    yield* wake;
    return { syncOnce, lastError: Ref.get(error) } satisfies ParentConnection;
});
