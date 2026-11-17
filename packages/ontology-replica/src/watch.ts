import { BackendError } from "@party-stack/ontology-backend";
import { Clock, Effect, Random, Redacted, Scope, Stream } from "effect";

/** What one supervised attempt achieved before it ended. */
export interface WatchAttempt {
    /** The subscription was acquired and could have reported changes. */
    readonly established: boolean;
    /** At least one change hint was delivered during this attempt. */
    readonly delivered: boolean;
}

const maxRetryDelayMs = 5 * 60_000;
const defaultStableMs = 60_000;

/** Each attempt has its own scope. Terminal failures stay observable; only
 * retryable failures reopen subscriptions. Normal EOF also needs a repair.
 * Retries back off exponentially with jitter up to five minutes. The backoff
 * resets after a delivered value or after an acquisition stays open long
 * enough to be considered stable.
 */
export const superviseWatch = Effect.fnUntraced(function* <A>(options: {
    readonly acquire: () => Effect.Effect<Stream.Stream<A, BackendError>, BackendError, Scope.Scope>;
    readonly canRun?: Effect.Effect<boolean>;
    readonly authentication?: {
        readonly generation: Effect.Effect<number>;
        readonly awaitActivation: (after: number) => Effect.Effect<void>;
        /** The credential an attempt uses, captured before it opens. */
        readonly credential?: Effect.Effect<number>;
        /** Renew a credential the source rejected after the subscription opened. Fails
         * only for a retryable problem; otherwise the connection publishes either a
         * renewed credential or that it needs sign-in. */
        readonly renew?: (credential: number) => Effect.Effect<void, BackendError>;
    };
    readonly onValue: (value: A) => Effect.Effect<void, BackendError>;
    readonly onError: (error: BackendError | undefined, attempt?: WatchAttempt) => Effect.Effect<void>;
    /** Runs instead of retrying after a non-retryable failure, e.g. a poll policy. */
    readonly onTerminal?: (error: BackendError) => Effect.Effect<void>;
    readonly retryDelayMs?: number;
    /** An acquisition open at least this long resets the retry backoff. */
    readonly stableMs?: number;
}) {
    const initialDelay = options.retryDelayMs ?? 1_000;
    const stableMs = options.stableMs ?? defaultStableMs;
    let delay = initialDelay;
    for (;;) {
        if (!(yield* options.canRun ?? Effect.succeed(true))) {
            yield* Effect.sleep(initialDelay);
            continue;
        }
        const generation = yield* options.authentication?.generation ?? Effect.succeed(0);
        const credential = yield* options.authentication?.credential ?? Effect.succeed(undefined);
        let established = false;
        let delivered = false;
        let openedAt: number | undefined;
        const result = yield* Effect.result(
            Effect.scoped(
                Effect.gen(function* () {
                    const stream = yield* options.acquire();
                    established = true;
                    openedAt = yield* Clock.currentTimeMillis;
                    yield* options.onError(undefined, { established, delivered });
                    yield* Stream.runForEach(stream, (value) =>
                        options.onValue(value).pipe(
                            Effect.tap(() =>
                                Effect.sync(() => {
                                    delivered = true;
                                    delay = initialDelay;
                                })
                            )
                        )
                    );
                }).pipe(
                    Effect.tapError((error) =>
                        Effect.annotateCurrentSpan({
                            errorKind: error.kind,
                            errorMessage: error.message,
                            established,
                            delivered,
                        })
                    ),
                    Effect.withSpan("Replica.watchAttempt", { attributes: { activity: "subscription" } })
                )
            ).pipe(
                Effect.catchDefect((cause) =>
                    Effect.fail(
                        new BackendError({
                            operation: "replica.watch",
                            kind: "Internal",
                            retryable: false,
                            message: "The change subscription failed internally.",
                            cause: Redacted.make(cause),
                        })
                    )
                )
            )
        );
        const error =
            result._tag === "Failure"
                ? result.failure
                : new BackendError({
                      operation: "replica.watch",
                      kind: "Unavailable",
                      retryable: true,
                      message: "The change subscription ended; reconnecting.",
                  });
        yield* options.onError(error, { established, delivered });
        let renewalFailed = false;
        if (error.kind === "Unauthenticated" && options.authentication) {
            const renew = options.authentication.renew;
            const renewed =
                renew && credential !== undefined ? yield* Effect.result(renew(credential)) : undefined;
            // A renewal that could not reach the provider is retried like any other
            // transient failure; otherwise wait for the renewed credential or a sign-in.
            renewalFailed = renewed?._tag === "Failure";
            if (!renewalFailed) {
                yield* options.authentication.awaitActivation(generation);
                delay = initialDelay;
                continue;
            }
        }
        if (!error.retryable && !renewalFailed) {
            if (options.onTerminal) yield* options.onTerminal(error);
            return;
        }
        if (openedAt !== undefined && (yield* Clock.currentTimeMillis) - openedAt >= stableMs)
            delay = initialDelay;
        // Equal jitter keeps at least half the backoff while spreading reconnects.
        const jittered = delay / 2 + (yield* Random.next) * (delay / 2);
        yield* Effect.sleep(Math.max(jittered, error.retryAfterMs ?? 0));
        delay = Math.min(delay * 2, maxRetryDelayMs);
    }
});
