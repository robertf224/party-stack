import { BackendError } from "@party-stack/ontology-backend";
import { Effect, MutableHashMap, Option, RcMap, Semaphore } from "effect";
import type { Scope } from "effect";

export interface DemandPolicy {
    /** Retain an unused subset's upstream demand for reuse. Zero releases immediately. */
    readonly idleRetentionMs?: number;
    /** Active plus idle distinct subsets; idle entries are evicted before rejecting new work. */
    readonly maxSubsets?: number;
}

/** One lease owner for all replica consumers, including cached-proxy requests. */
export const makeDemandCache = Effect.fnUntraced(function* (options: {
    readonly policy?: DemandPolicy;
    readonly acquire: (key: string) => Effect.Effect<void, BackendError, Scope.Scope>;
}) {
    const idle = options.policy?.idleRetentionMs ?? 0;
    const capacity = options.policy?.maxSubsets ?? 1_024;
    if (!Number.isFinite(idle) || idle < 0 || !Number.isSafeInteger(capacity) || capacity < 1)
        return yield* new BackendError({
            operation: "replica.demand",
            kind: "InvalidConfiguration",
            message: "Invalid demand retention bounds.",
            retryable: false,
        });
    const leases = yield* RcMap.make({ lookup: options.acquire, capacity, idleTimeToLive: idle });
    const admission = yield* Semaphore.make(1);
    const full = () =>
        new BackendError({
            operation: "replica.demand",
            kind: "RateLimited",
            message: "Demand capacity reached; all subsets are active.",
            retryable: true,
            actionOutcome: "not-committed",
        });
    const acquire = (key: string) =>
        admission.withPermit(
            RcMap.get(leases, key).pipe(
                Effect.catchTag("ExceededCapacityError", () =>
                    Effect.gen(function* () {
                        const idleEntries =
                            leases.state._tag === "Open"
                                ? [...leases.state.map].filter(([, entry]) => entry.refCount === 0)
                                : [];
                        idleEntries.sort((a, b) => a[1].expiresAt - b[1].expiresAt);
                        if (!idleEntries[0]) return yield* full();
                        yield* RcMap.invalidate(leases, idleEntries[0][0]);
                        return yield* RcMap.get(leases, key).pipe(
                            Effect.catchTag("ExceededCapacityError", full)
                        );
                    })
                )
            )
        );
    return {
        acquire,
        state: (key: string) => {
            const entry =
                leases.state._tag === "Open"
                    ? Option.getOrUndefined(MutableHashMap.get(leases.state.map, key))
                    : undefined;
            return {
                references: entry?.refCount ?? 0,
                idleUntil: entry?.refCount === 0 ? entry.expiresAt : undefined,
            };
        },
    };
});
