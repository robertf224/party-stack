export interface ActionWaitOptions {
    /** Accepted by the immediate parent, or committed upstream and reconciled locally. */
    readonly until?: "accepted" | "confirmed";
}
export interface ReplicaOutboxPolicy {
    /** Additional automatic attempts after the first dispatch. Defaults to 3. */
    readonly maxRetries?: number;
    /** Exponential retry delay, capped at 60 seconds. Defaults to 1 second. */
    readonly retryDelayMs?: number;
    /** Backend dispatch deadline in milliseconds. Defaults to 30 seconds. Infinity disables it.
     * A timeout has an unknown outcome and follows the configured retry and failure policies. */
    readonly dispatchTimeoutMs?: number;
    /** Abandon pending intent on terminal failure, including unknown remote outcomes. */
    readonly failureStrategy?: "pause" | "discard-all";
    /** See ReplicaConfiguration.outbox.prediction. */
    readonly prediction?: "local" | "source";
}
export interface ObjectCacheSweepOptions {
    /** Minimum time since a row was last accessed before it can be considered. Defaults to 24 hours.
     * Active demand, pending actions and explicit pins still protect older rows. */
    readonly minUnusedAgeMs?: number;
    /** Maximum candidates examined, including protected rows. Defaults to 100; maximum 10,000. */
    readonly maxCandidates?: number;
}
export interface ObjectCacheGcPolicy extends ObjectCacheSweepOptions {
    readonly maxBytes?: number;
    readonly targetBytes?: number;
    /** Time between automatic bounded sweeps. Defaults to 60 seconds. */
    readonly sweepIntervalMs?: number;
}

export interface ObjectCachePolicy extends ObjectCacheGcPolicy {
    /** Persist the broader fulfilled subset's objects and coverage. Defaults to false.
     * Extra rows are ordinary evictable cache data, not additional demand roots.
     */
    readonly storeBroaderSubsets?: boolean;
}
