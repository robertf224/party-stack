import { BackendError } from "@party-stack/ontology-backend";
import { Effect, Stream } from "effect";

/** Each attempt has its own scope. Terminal failures stay observable; only
 * retryable failures reopen subscriptions. Normal EOF also needs a repair.
 */
export const superviseWatch = Effect.fnUntraced(function* <A>(options: {
    readonly stream: () => Stream.Stream<A, BackendError>;
    readonly online?: Effect.Effect<boolean>;
    readonly onValue: (value: A) => Effect.Effect<void>;
    readonly onError: (error: BackendError | undefined) => Effect.Effect<void>;
    readonly retryDelayMs?: number;
}) {
    const initialDelay = options.retryDelayMs ?? 1_000;
    let delay = initialDelay;
    for (;;) {
        if (!(yield* options.online ?? Effect.succeed(true))) {
            yield* Effect.sleep(initialDelay);
            continue;
        }
        const result = yield* Effect.result(
            Effect.scoped(
                Effect.gen(function* () {
                    yield* options.onError(undefined);
                    yield* Stream.runForEach(Stream.suspend(options.stream), (value) =>
                        options.onValue(value).pipe(
                            Effect.tap(() =>
                                Effect.sync(() => {
                                    delay = initialDelay;
                                })
                            )
                        )
                    );
                }).pipe(Effect.withSpan("Replica.watchAttempt", { attributes: { activity: "subscription" } }))
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
        yield* options.onError(error);
        if (!error.retryable) return;
        yield* Effect.sleep(Math.max(delay, error.retryAfterMs ?? 0));
        delay = Math.min(delay * 2, 30_000);
    }
});
