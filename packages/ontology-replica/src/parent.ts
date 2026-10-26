import { BackendError } from "@party-stack/ontology-backend";
import { Clock, Effect, Queue, Ref, Stream } from "effect";
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
    demand: (subset) => parent.demand(subset).pipe(Effect.andThen(parent.syncOnce)),
    subscribeChanges: parent.subscribeChanges,
    submit: parent.submitClient,
    acknowledge: parent.acknowledgeClient,
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
            kind: "ValidationFailed",
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
    let closed = false;
    yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
            closed = true;
        }).pipe(Effect.andThen(Queue.shutdown(queue)))
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
        Stream.runForEach(childChanges, () => wake),
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
                yield* Effect.raceFirst(Queue.take(queue), Effect.sleep(delay));
                const result = yield* Effect.result(syncOnce);
                if (result._tag === "Failure" && result.failure.retryable) {
                    yield* Effect.sleep(retryIntervalMs);
                    yield* wake;
                }
            }
        }),
        { startImmediately: true }
    );
    yield* wake;
    return { syncOnce, lastError: Ref.get(error) } satisfies ParentConnection;
});
