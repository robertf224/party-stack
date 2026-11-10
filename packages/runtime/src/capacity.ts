import { Effect } from "effect";
import { RuntimeError } from "./Runtime.js";

/** Estimates describe the named shared resource, not a reservation for this partition. */
export interface CapacityEstimate {
    readonly scope: "origin" | "filesystem" | "process" | "isolate" | "database";
    readonly usedBytes?: number;
    readonly limitBytes?: number;
    readonly availableBytes?: number;
}
export interface ResourceCapacity {
    readonly memory: Effect.Effect<CapacityEstimate | undefined, RuntimeError>;
    readonly storage: Effect.Effect<CapacityEstimate | undefined, RuntimeError>;
}

/** Workers expose an isolate limit, not measurable free heap. DO SQLite exposes
 * databaseSize; its quota is supplied explicitly because plans can differ.
 */
export const cloudflareCapacity = (options?: {
    readonly sql?: { readonly databaseSize: number };
    readonly storageLimitBytes?: number;
    readonly memoryLimitBytes?: number;
}): ResourceCapacity => ({
    memory: Effect.sync(() => ({
        scope: "isolate",
        limitBytes: options?.memoryLimitBytes ?? 128 * 1024 * 1024,
    })),
    storage: Effect.try({
        try: () =>
            options?.sql
                ? {
                      scope: "database" as const,
                      usedBytes: options.sql.databaseSize,
                      limitBytes: options.storageLimitBytes,
                      availableBytes:
                          options.storageLimitBytes === undefined
                              ? undefined
                              : Math.max(0, options.storageLimitBytes - options.sql.databaseSize),
                  }
                : undefined,
        catch: (cause) => new RuntimeError({ operation: "capacity.storage", cause }),
    }),
});
