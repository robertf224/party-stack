import { BackendError } from "@party-stack/ontology-backend";
import { Effect } from "effect";

/** The credential backend owns one scoped sweep. Serverless hosts opt out and
 * invoke backend.maintenance from their alarm/job instead.
 */
export const maintainConnect = Effect.fnUntraced(function* (
    work: Effect.Effect<void, BackendError>,
    options: false | { readonly intervalMs?: number } | undefined
) {
    const intervalMs = options && options.intervalMs !== undefined ? options.intervalMs : 60_000;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0)
        return yield* new BackendError({
            operation: "connect.maintenance",
            kind: "InvalidConfiguration",
            retryable: false,
            message: "Connect maintenance interval must be positive and finite.",
        });
    if (options === false) return;
    return yield* Effect.forkScoped(
        Effect.forever(
            Effect.sleep(intervalMs).pipe(
                Effect.andThen(work),
                Effect.catch((error) => Effect.logWarning("Connect maintenance failed", { kind: error.kind }))
            )
        )
    );
});
