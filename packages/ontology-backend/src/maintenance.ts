import { Effect } from "effect";
import { BackendError } from "./index.js";

export const maintenanceInterval = Effect.fnUntraced(function* (
    policy: false | { readonly intervalMs?: number } | undefined
) {
    if (policy === false) return false as const;
    const interval = policy?.intervalMs ?? 60_000;
    if (!Number.isSafeInteger(interval) || interval < 1)
        return yield* new BackendError({
            operation: "maintenance",
            kind: "InvalidConfiguration",
            retryable: false,
            message: "Maintenance interval must be a positive integer.",
        });
    return interval;
});

/** One scheduler in the acquisition scope, shared by low-level and storage-backed owners. */
export const scheduleMaintenance = Effect.fnUntraced(function* (
    maintenance: Effect.Effect<void, BackendError>,
    interval: number | false
) {
    if (interval === false) return;
    yield* Effect.forkScoped(
        Effect.forever(
            Effect.sleep(interval).pipe(
                Effect.andThen(maintenance),
                Effect.catch((error) =>
                    Effect.logWarning("Ontology maintenance failed", { kind: error.kind })
                )
            )
        )
    );
});
