import type { PerformanceSpan } from "./traceWaterfall.js";
import type { LiveOntology } from "@party-stack/ontology";

type Diagnostics = NonNullable<LiveOntology["diagnostics"]>;
export type ReplicationStatus = NonNullable<ReturnType<Diagnostics["replica"]["getSnapshot"]>["status"]>;
export type ReplicationLoad = ReplicationStatus["loads"][number];
export type ReplicationDemand = ReplicationStatus["demands"][number];
/** Keep every span for the timeline, filling only requests whose span has left the trace buffer. */
export function diagnosticSpans(
    spans: readonly PerformanceSpan[],
    loads: readonly ReplicationLoad[]
): readonly PerformanceSpan[] {
    const retained = new Set(spans.map((span) => `${span.traceId}:${span.id}`));
    return [
        ...spans,
        ...loads.flatMap((load) => {
            const id = load.spanId ?? `load:${load.id}`;
            const traceId = load.traceId ?? `request:${load.id}`;
            if (retained.has(`${traceId}:${id}`)) return [];
            const attributes: PerformanceSpan["attributes"] = load.subset
                ? { objectType: load.subset.objectType }
                : {};
            return [
                {
                    id,
                    traceId,
                    name: `Replica.upstream.${load.operation}`,
                    startedAt: load.startedAt,
                    durationMs:
                        load.finishedAt === undefined ? 0 : Math.max(0, load.finishedAt - load.startedAt),
                    outcome: load.outcome,
                    ...(load.error ? { error: { kind: "Error" as const, message: load.error.message } } : {}),
                    attributes,
                },
            ];
        }),
    ];
}
export const queryText = (value: unknown) =>
    JSON.stringify(value ?? {}, (_, item: unknown) => (typeof item === "bigint" ? `${item}n` : item), 2);
export const demandId = (demand: Pick<ReplicationDemand, "objectType" | "query">) =>
    JSON.stringify({ objectType: demand.objectType, query: demand.query }, (_, value: unknown) => {
        if (typeof value === "bigint") return `${value}n`;
        // Storage copies and RPC can reorder object keys. Array order (including
        // predicate and ordering precedence) remains significant.
        return value && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
            : value;
    });
export function replicationState(status: ReplicationStatus | undefined, error?: string) {
    if (error) return "Monitoring disconnected";
    if (!status) return "Connecting…";
    if (status.networkOnline === false) return "Offline";
    if (status.connection?.status === "needs-auth") return "Sign-in required";
    if (status.connection?.status === "error") return "Connection failed";
    if (status.connection?.status === "inactive") return "Disconnected";
    if (status.connection?.status === "pending") return "Connecting…";
    if (status.syncing) return "Syncing";
    if (status.lastSync?.outcome === "failure") return "Sync failed";
    if ((status.outbox.blocked ?? 0) > 0) return "Outbox paused";
    return (status.outbox.acknowledged ?? 0) > 0 ? "Awaiting confirmation" : "Idle";
}

/** Exact recorded subset identity only; never attribute a broader/cache-covering load by type alone. */
export function queryLoads(
    demand: Pick<ReplicationDemand, "objectType" | "query">,
    loads: readonly ReplicationLoad[]
) {
    const key = demandId(demand);
    return loads.filter(
        (load) => load.operation === "loadSubset" && load.subset && demandId(load.subset) === key
    );
}
