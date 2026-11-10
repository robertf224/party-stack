import type { LiveOntology } from "@party-stack/ontology";

export type PerformanceSpan = ReturnType<NonNullable<LiveOntology["traces"]>["getSnapshot"]>[number];
export function groupTraces(spans: readonly PerformanceSpan[]) {
    const groups = new Map<string, PerformanceSpan[]>();
    for (const span of spans) {
        const group = groups.get(span.traceId) ?? [];
        group.push(span);
        groups.set(span.traceId, group);
    }
    return [...groups.entries()]
        .map(([id, spans]) => {
            const ids = new Set(spans.map((span) => span.id));
            const root = spans.find((span) => !span.parentId || !ids.has(span.parentId)) ?? spans[0]!;
            return {
                id,
                spans,
                name: root.name,
                startedAt: Math.min(...spans.map((span) => span.startedAt)),
                failed: spans.some((span) => span.outcome === "failure"),
                running: spans.some((span) => span.outcome === "running"),
            };
        })
        .sort((a, b) => b.startedAt - a.startedAt);
}

/** Keeps gaps and overlapping children on the same clock; evicted parents become visible roots. */
export function traceWaterfall(spans: readonly PerformanceSpan[], now: number) {
    const endOf = (span: PerformanceSpan) =>
        span.startedAt + (span.outcome === "running" ? Math.max(0, now - span.startedAt) : span.durationMs);
    const start = spans.length ? Math.min(...spans.map((span) => span.startedAt)) : 0;
    const end = spans.length ? Math.max(...spans.map(endOf)) : start;
    const duration = Math.max(end - start, 0.001);
    const ids = new Set(spans.map((span) => span.id));
    const children = new Map<string, PerformanceSpan[]>();
    for (const span of spans) {
        const parent = span.parentId && ids.has(span.parentId) ? span.parentId : "";
        const list = children.get(parent) ?? [];
        list.push(span);
        children.set(parent, list);
    }
    for (const list of children.values()) list.sort((a, b) => a.startedAt - b.startedAt);
    const rows: { span: PerformanceSpan; depth: number; offset: number; duration: number; self: number }[] =
        [];
    const visited = new Set<string>();
    const visit = (span: PerformanceSpan, depth: number) => {
        if (visited.has(span.id)) return;
        visited.add(span.id);
        const nested = children.get(span.id) ?? [];
        const intervals = nested
            .map(
                (child) =>
                    [Math.max(span.startedAt, child.startedAt), Math.min(endOf(span), endOf(child))] as const
            )
            .filter(([a, b]) => b > a)
            .sort((a, b) => a[0] - b[0]);
        let covered = 0;
        let until = span.startedAt;
        for (const [a, b] of intervals) {
            covered += Math.max(0, b - Math.max(a, until));
            until = Math.max(until, b);
        }
        const elapsed = Math.max(0, endOf(span) - span.startedAt);
        rows.push({
            span,
            depth,
            offset: span.startedAt - start,
            duration: elapsed,
            self: Math.max(0, elapsed - covered),
        });
        for (const child of nested) visit(child, depth + 1);
    };
    for (const root of children.get("") ?? []) visit(root, 0);
    // A damaged or partial buffer must not hide spans or recurse indefinitely.
    for (const span of spans) if (!visited.has(span.id)) visit(span, 0);
    return { start, duration, rows };
}
