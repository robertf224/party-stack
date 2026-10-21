import { Effect, Queue } from "effect";
import type { WatcherError } from "./model.js";
import type { Scope } from "effect";

/** Logical subscriptions survive each scoped physical connection and its retries. */
export const runWatcherSession = Effect.fnUntraced(function* (options: {
    readonly hasDemand: () => boolean;
    readonly changes: Queue.Queue<void>;
    readonly connect: () => Effect.Effect<void, WatcherError, Scope.Scope>;
    readonly disconnected: Effect.Effect<void>;
    readonly retryDelayMs: number;
}) {
    yield* Effect.forever(
        Effect.gen(function* () {
            if (!options.hasDemand()) {
                yield* Queue.take(options.changes);
                return;
            }
            yield* Effect.scoped(options.connect()).pipe(Effect.catch(() => options.disconnected));
            yield* Effect.sleep(options.retryDelayMs);
        })
    );
});
