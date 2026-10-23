import { Duration, Effect } from "effect";
import type { ConnectService } from "./Connect.js";

/** Optional scheduler for long-lived processes. Serverless hosts call collectExpired
 * from their alarm/job instead. Closing the caller's scope stops this fiber.
 */
export const maintainConnect = Effect.fnUntraced(function* (
    connect: ConnectService,
    options: {
        interval?: Duration.Input;
        batchSize?: number;
    } = {}
) {
    return yield* Effect.forkScoped(
        Effect.forever(
            Effect.gen(function* () {
                yield* connect
                    .collectExpired({ limit: options.batchSize ?? 100 })
                    .pipe(
                        Effect.catch((error) =>
                            Effect.logWarning("Connect maintenance failed", { kind: error.kind })
                        )
                    );
                yield* Effect.sleep(options.interval ?? "5 minutes");
            })
        )
    );
});
