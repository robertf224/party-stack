import { traceWaterfall } from "./traceWaterfall.js";
import type { PerformanceSpan } from "./traceWaterfall.js";

export const spanKey = (span: Pick<PerformanceSpan, "id" | "traceId">) => `${span.traceId}:${span.id}`;
export const isSubscription = (span: PerformanceSpan) => span.attributes.activity === "subscription";
export const traceStatus = (span: PerformanceSpan) =>
    span.outcome === "running"
        ? isSubscription(span)
            ? "Open"
            : "Running"
        : span.outcome === "success"
          ? isSubscription(span)
              ? "Closed"
              : "Success"
          : span.outcome === "interrupted"
            ? isSubscription(span)
                ? "Stopped"
                : "Cancelled"
            : "Failed";

/** Trace-qualified hierarchy for the operation table, independent of the selected waterfall. */
export function operationRows(spans: readonly PerformanceSpan[], now: number) {
    const originals = new Map(spans.map((span) => [spanKey(span), span]));
    const chart = traceWaterfall(
        spans.map((span) => {
            const parent = span.parentId ? `${span.traceId}:${span.parentId}` : undefined;
            return {
                ...span,
                id: spanKey(span),
                parentId:
                    isSubscription(span) || (parent && isSubscription(originals.get(parent) ?? span))
                        ? undefined
                        : parent,
            };
        }),
        now
    );
    return chart.rows.map((row) => ({
        span: originals.get(row.span.id)!,
        depth: row.depth,
        durationMs: row.duration,
    }));
}
/** Selection is a subtree, not every operation sharing a trace ID. */
export function spanSubtree(spans: readonly PerformanceSpan[], root: PerformanceSpan) {
    const ids = new Set([root.id]);
    const candidates = spans.filter((span) => span.traceId === root.traceId);
    let size = 0;
    while (size !== ids.size) {
        size = ids.size;
        for (const span of candidates) if (span.parentId && ids.has(span.parentId)) ids.add(span.id);
    }
    return candidates.filter((span) => ids.has(span.id));
}
