import {
    Box,
    ChevronDown,
    Database,
    Filter,
    Layers,
    Plug,
    Radio,
    RefreshCw,
    Send,
    Trash2,
    Workflow,
    X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { diagnosticTargets, ms, useReplicaStatus, useTraceSpans } from "./diagnostics.js";
import { QueryPills } from "./QueryPills.js";
import { diagnosticSpans } from "./replicationActivity.js";
import { operationRows, spanKey, spanSubtree, isSubscription, traceStatus } from "./traceTimeline.js";
import { traceWaterfall } from "./traceWaterfall.js";
import type { Diagnostics, Load } from "./diagnostics.js";
import type { PerformanceSpan } from "./traceWaterfall.js";
import type { LiveOntology } from "@party-stack/ontology";

type Sort = "name" | "startedAt" | "duration" | "status";
export function Tracing({ ontology }: { ontology: LiveOntology }) {
    const targets = diagnosticTargets(ontology.diagnostics);
    const [index, setIndex] = useState(() => (ontology.diagnostics?.parent ? 1 : 0));
    const target = targets[index] ?? targets[0];
    return (
        <div className="ps-diagnostics-screen" aria-label="Tracing inspector">
            <Timeline
                key={index}
                diagnostics={target?.value}
                traces={target ? target.value.traces : ontology.traces}
                ontology={ontology}
                source={
                    targets.length > 1 ? (
                        <span className="ps-trace-source-select">
                            <select
                                aria-label="Trace source"
                                value={index}
                                onChange={(event) => setIndex(Number(event.target.value))}
                            >
                                {targets.map((item, key) => (
                                    <option value={key} key={key}>
                                        {item.label}
                                    </option>
                                ))}
                            </select>
                            <ChevronDown size={12} aria-hidden />
                        </span>
                    ) : (
                        <strong>{target?.label ?? "This tab"}</strong>
                    )
                }
            />
        </div>
    );
}
function Timeline({
    diagnostics,
    traces,
    ontology,
    source,
}: {
    diagnostics?: Diagnostics;
    traces?: LiveOntology["traces"];
    ontology: LiveOntology;
    source: React.ReactNode;
}) {
    const { status, error } = useReplicaStatus(diagnostics);
    const recorded = useTraceSpans(traces);
    const incoming = useMemo(() => diagnosticSpans(recorded, status?.loads ?? []), [recorded, status?.loads]);
    const [paused, pause] = useState<{
        spans: readonly PerformanceSpan[];
        loads: readonly Load[];
        now: number;
    }>();
    const [now, setNow] = useState(() => Date.now());
    const [selected, select] = useState<PerformanceSpan>();
    const [all, showAll] = useState(false);
    const [sort, setSort] = useState<{ by: Sort; desc: boolean }>({ by: "startedAt", desc: true });
    useEffect(() => {
        if (paused) return;
        const timer = setInterval(() => setNow(Date.now()), 250);
        return () => clearInterval(timer);
    }, [paused]);
    const spans = paused?.spans ?? incoming;
    const clock = paused?.now ?? now;
    const loads = paused?.loads ?? status?.loads ?? [];
    const requests = new Map(
        loads
            .filter((load) => load.spanId && load.traceId)
            .map((load) => [`${load.traceId}:${load.spanId}`, load])
    );
    const chart = useMemo(() => operationRows(spans, clock), [spans, clock]);
    const groups: (typeof chart)[] = [];
    for (const row of chart) {
        if (!row.depth || !groups.length) groups.push([]);
        groups[groups.length - 1]!.push(row);
    }
    groups.sort((a, b) => {
        const left = a[0]!,
            right = b[0]!;
        const diff =
            sort.by === "name"
                ? left.span.name.localeCompare(right.span.name)
                : sort.by === "status"
                  ? left.span.outcome.localeCompare(right.span.outcome)
                  : sort.by === "duration"
                    ? left.durationMs - right.durationMs
                    : left.span.startedAt - right.span.startedAt;
        return (sort.desc ? -1 : 1) * diff;
    });
    const rows = groups.flatMap((group) => (all ? group : group.slice(0, 1)));
    const current = selected
        ? (spans.find((span) => spanKey(span) === spanKey(selected)) ?? selected)
        : undefined;
    const sortHeader = (by: Sort, title: string) => (
        <th
            className={by === "duration" ? "ps-trace-numeric" : undefined}
            aria-sort={sort.by === by ? (sort.desc ? "descending" : "ascending") : "none"}
        >
            <button
                type="button"
                onClick={() => setSort({ by, desc: sort.by === by ? !sort.desc : by !== "name" })}
            >
                {by === "duration" && (
                    <span aria-hidden>{sort.by === by ? (sort.desc ? "↓" : "↑") : "↕"}</span>
                )}
                <span>{title}</span>
                {by !== "duration" && (
                    <span aria-hidden>{sort.by === by ? (sort.desc ? "↓" : "↑") : "↕"}</span>
                )}
            </button>
        </th>
    );
    return (
        <>
            <header className="ps-diagnostics-toolbar ps-trace-toolbar">
                <div className="ps-trace-source">
                    <span>Source</span>
                    {source}
                </div>
                <span className="ps-trace-toolbar-separator" aria-hidden />
                <label>
                    <input
                        type="checkbox"
                        checked={all}
                        onChange={(event) => showAll(event.target.checked)}
                    />
                    Child spans
                </label>
                <span className="ps-trace-toolbar-separator" aria-hidden />
                <button
                    type="button"
                    aria-pressed={Boolean(paused)}
                    onClick={() => {
                        if (paused) {
                            setNow(Date.now());
                            pause(undefined);
                        } else pause({ spans: incoming, loads, now: Date.now() });
                    }}
                >
                    {paused ? "Resume live" : "Pause"}
                </button>
            </header>
            {error && (
                <p role="alert" className="ps-replication-error">
                    {error} · trace data may be stale
                </p>
            )}
            <div className="ps-timeline-scroll ps-object-table-scroll" aria-label="Tracing timeline viewport">
                <table className="ps-timeline" aria-label="Tracing timeline">
                    <colgroup>
                        <col style={{ width: 330 }} />
                        <col style={{ width: 100 }} />
                        <col style={{ width: 110 }} />
                        <col style={{ width: 110 }} />
                        <col style={{ width: 85 }} />
                        <col />
                    </colgroup>
                    <thead>
                        <tr>
                            {sortHeader("name", "Operation")}
                            {sortHeader("status", "Status")}
                            {sortHeader("startedAt", "Started")}
                            {sortHeader("duration", "Duration")}
                            <th
                                className="ps-trace-numeric"
                                title="Recorded subscription lifecycle and invalidation events; not row updates, network frames or consumer counts"
                            >
                                Events
                            </th>
                            <th aria-hidden />
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row) => {
                            const id = spanKey(row.span),
                                subscription = isSubscription(row.span);
                            const request = requests.get(id);
                            return (
                                <tr key={id} data-selected={current && spanKey(current) === id}>
                                    <td>
                                        <button
                                            type="button"
                                            className="ps-timeline-name"
                                            style={{ paddingLeft: 10 + Math.min(row.depth, 8) * 12 }}
                                            title={row.span.name}
                                            aria-label={row.span.name}
                                            onClick={() => select(row.span)}
                                        >
                                            <ActivityIcon span={row.span} />
                                            {row.depth > 0 && <span className="ps-timeline-branch">↳</span>}
                                            {row.span.name}
                                            {request?.subset && <small> · {request.subset.objectType}</small>}
                                        </button>
                                    </td>
                                    <td>
                                        <span className="ps-trace-status" data-outcome={row.span.outcome}>
                                            <span className="ps-trace-status-dot" aria-hidden />
                                            {traceStatus(row.span)}
                                        </span>
                                    </td>
                                    <td className="ps-timeline-time">
                                        {new Date(row.span.startedAt).toLocaleTimeString()}
                                    </td>
                                    <td className="ps-timeline-duration">{ms(row.durationMs)}</td>
                                    <td className="ps-timeline-messages">
                                        {subscription && row.span.eventCount !== undefined
                                            ? row.span.eventCount
                                            : "—"}
                                    </td>
                                    <td aria-hidden />
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
                {!rows.length && <p className="ps-replication-empty">No recorded operations.</p>}
            </div>
            {current && (
                <TraceDetails
                    span={current}
                    spans={spans}
                    load={requests.get(spanKey(current))}
                    now={clock}
                    ontology={ontology}
                    onClose={() => select(undefined)}
                />
            )}
        </>
    );
}
function ActivityIcon({ span }: { span: PerformanceSpan }) {
    const operation = span.name.split(".").at(-1)?.toLowerCase() ?? "";
    const Icon =
        operation === "collectgarbage"
            ? Trash2
            : operation === "sync" || operation === "syncparent"
              ? RefreshCw
              : operation === "demand"
                ? Filter
                : operation.startsWith("watch") || isSubscription(span)
                  ? Radio
                  : operation.startsWith("connect")
                    ? Plug
                    : operation === "replay" || operation === "rebase"
                      ? Layers
                      : operation === "dispatch" || operation.startsWith("submit") || operation === "enqueue"
                        ? Send
                        : operation.startsWith("load") ||
                            operation.startsWith("read") ||
                            operation === "pullchanges"
                          ? Database
                          : operation === "make" || operation === "open" || operation === "view"
                            ? Box
                            : Workflow;
    return <Icon className="ps-trace-icon" data-outcome={span.outcome} aria-hidden size={13} />;
}
function TraceDetails({
    span,
    spans,
    load,
    now,
    ontology,
    onClose,
}: {
    span: PerformanceSpan;
    spans: readonly PerformanceSpan[];
    load?: Load;
    now: number;
    ontology: LiveOntology;
    onClose: () => void;
}) {
    const object = ontology.ir.objectTypes.find((type) => type.name === load?.subset?.objectType);
    const subscription = isSubscription(span);
    const subtree = spanSubtree(spans, span);
    const chart = traceWaterfall(subtree, now);
    return (
        <aside className="ps-timeline-details" aria-label="Trace details">
            <div className="ps-timeline-details-heading">
                <button type="button" aria-label="Close trace details" onClick={onClose}>
                    <X size={14} />
                </button>
                <ActivityIcon span={span} />
                <strong>{span.name}</strong>
            </div>
            <div className="ps-trace-detail-body">
                <div className="ps-timeline-attributes">
                    <span className="ps-trace-status" data-outcome={span.outcome}>
                        {traceStatus(span)}
                    </span>
                    <span>
                        {ms(span.outcome === "running" ? Math.max(0, now - span.startedAt) : span.durationMs)}
                    </span>
                    {load?.fetchedRows !== undefined && <span>{load.fetchedRows} fetched</span>}
                    {load?.rows !== undefined && <span>{load.rows} returned</span>}
                    {Object.entries(span.attributes)
                        .filter(([key]) => key !== "activity")
                        .map(([key, value]) => (
                            <span key={key}>
                                {key}: {String(value)}
                            </span>
                        ))}
                </div>
                {span.outcome === "interrupted" && (
                    <p className="ps-trace-note">
                        {subscription ? "Subscription stopped" : "Operation cancelled"}: Effect was
                        interrupted, for example when its consumer unsubscribes or its scope closes. No error
                        was reported.
                    </p>
                )}
                {span.outcome === "failure" && (
                    <p className="ps-replication-error">
                        {load?.error?.message ??
                            span.error?.message ??
                            "Effect failed; no error message was captured for this span."}
                        {span.error?.kind === "Defect" && " (unexpected defect)"}
                    </p>
                )}
                {load?.subset && (
                    <QueryPills
                        query={load.subset.query}
                        object={object}
                        objectType={load.subset.objectType}
                    />
                )}
                {subscription ? (
                    <>
                        <h4>
                            Events <span>{span.eventCount ?? 0}</span>
                        </h4>
                        {(span.eventCount ?? 0) > (span.events?.length ?? 0) && (
                            <p className="ps-trace-note">Latest {span.events?.length} events</p>
                        )}
                        <table className="ps-trace-messages" aria-label="Subscription events">
                            <thead>
                                <tr>
                                    <th>Time</th>
                                    <th>Event</th>
                                </tr>
                            </thead>
                            <tbody>
                                {span.events?.map((event, index) => (
                                    <tr key={index}>
                                        <td>{new Date(event.at).toLocaleTimeString()}</td>
                                        <td>{event.name.replace("replica.", "")}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {!span.events?.length && <p className="ps-trace-note">No events recorded.</p>}
                    </>
                ) : (
                    <>
                        <h4>Waterfall</h4>
                        <table className="ps-trace-waterfall" aria-label="Operation waterfall">
                            <tbody>
                                {chart.rows.map((row) => (
                                    <tr key={row.span.id}>
                                        <td style={{ paddingLeft: row.depth * 10 }} title={row.span.name}>
                                            {row.span.name}
                                        </td>
                                        <td
                                            aria-label={`${ms(row.offset)} after start, ${ms(row.duration)} duration`}
                                        >
                                            <div className="ps-timeline-hit">
                                                <span
                                                    className="ps-timeline-bar"
                                                    data-outcome={row.span.outcome}
                                                    style={{
                                                        left: `${(row.offset / chart.duration) * 100}%`,
                                                        width: `${(row.duration / chart.duration) * 100}%`,
                                                    }}
                                                />
                                            </div>
                                        </td>
                                        <td>{ms(row.duration)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </>
                )}
            </div>
        </aside>
    );
}
