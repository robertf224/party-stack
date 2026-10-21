import { Effect, Fiber, Result } from "effect";
import { abortError, normalizeError } from "../internal.js";
import type { Scope } from "effect";

/** Promise boundary for legacy consumers; the host scope owns all request fibers. */
export function runInEffectScope<A, E>(
    scope: Scope.Scope,
    work: Effect.Effect<A, E, Scope.Scope>,
    signals: readonly (AbortSignal | undefined)[] = []
): Promise<A> {
    const supplied = signals.filter((signal): signal is AbortSignal => signal !== undefined);
    const signal = supplied.length ? AbortSignal.any(supplied) : undefined;
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return Effect.runPromise(
        Effect.result(
            Effect.gen(function* () {
                const fiber = yield* Effect.forkIn(Effect.scoped(work), scope, {
                    startImmediately: true,
                });
                return yield* Fiber.join(fiber).pipe(Effect.ensuring(Fiber.interrupt(fiber)));
            })
        ),
        { signal }
    )
        .then(Result.getOrThrow)
        .catch((cause: unknown) => {
            if (signal?.aborted) throw abortError(signal);
            throw normalizeError(cause);
        });
}
