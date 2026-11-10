import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { diagnosticTargets, useReplicaStatus } from "./diagnostics.js";
import type { Status } from "./diagnostics.js";
import type { LiveOntology } from "@party-stack/ontology";

const bytes = (value?: number) => {
    if (value === undefined) return "Unavailable";
    if (value < 1024) return `${value} B`;
    const unit = Math.min(3, Math.floor(Math.log(value) / Math.log(1024)));
    return `${(value / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${["B", "KiB", "MiB", "GiB"][unit]}`;
};
type StorageView = "total" | "available" | "objects" | "attachments";
type StorageStatus = Pick<Status, "cache" | "capacity">;
const views = (status?: StorageStatus): readonly { value: StorageView; label: string }[] => [
    { value: "total", label: "Total usage" },
    ...(status?.capacity?.storage?.availableBytes !== undefined
        ? [{ value: "available" as const, label: "Available storage" }]
        : []),
    ...(status?.cache?.objects.maxBytes !== undefined
        ? [{ value: "objects" as const, label: "Object budget" }]
        : []),
    ...(status?.cache?.attachments?.maxBytes !== undefined
        ? [{ value: "attachments" as const, label: "Attachment budget" }]
        : []),
];

export function Storage({ ontology }: { ontology: LiveOntology }) {
    const targets = diagnosticTargets(ontology.diagnostics);
    const [index, setIndex] = useState(() => (ontology.diagnostics?.parent ? 1 : 0));
    const target = targets[index] ?? targets[0];
    const snapshot = useReplicaStatus(target?.value);
    const [view, setView] = useState<StorageView>("total");
    const choices = views(snapshot.status);
    const selected = choices.some((choice) => choice.value === view) ? view : "total";
    return (
        <div className="ps-diagnostics-screen ps-storage" aria-label="Storage inspector">
            <header className="ps-diagnostics-toolbar ps-trace-toolbar">
                <div className="ps-trace-source">
                    <span>Source</span>
                    {targets.length > 1 ? (
                        <span className="ps-trace-source-select">
                            <select
                                aria-label="Storage source"
                                value={index}
                                onChange={(event) => setIndex(Number(event.target.value))}
                            >
                                {targets.map((item, key) => (
                                    <option key={key} value={key}>
                                        {item.label}
                                    </option>
                                ))}
                            </select>
                            <ChevronDown size={12} aria-hidden />
                        </span>
                    ) : (
                        <strong>{target?.label ?? "This tab"}</strong>
                    )}
                </div>
                <span className="ps-trace-toolbar-separator" aria-hidden />
                <div className="ps-trace-source">
                    <span>View</span>
                    <span className="ps-trace-source-select">
                        <select
                            aria-label="Storage view"
                            value={selected}
                            onChange={(event) => setView(event.target.value as StorageView)}
                        >
                            {choices.map((choice) => (
                                <option key={choice.value} value={choice.value}>
                                    {choice.label}
                                </option>
                            ))}
                        </select>
                        <ChevronDown size={12} aria-hidden />
                    </span>
                </div>
            </header>
            <div className="ps-storage-content">
                {snapshot.error && <p role="alert">{snapshot.error}</p>}
                {snapshot.status ? (
                    <StorageDetails
                        status={snapshot.status}
                        objectTypes={ontology.ir.objectTypes}
                        view={selected}
                    />
                ) : (
                    <p className="ps-replication-empty">
                        {snapshot.error
                            ? "Storage information unavailable."
                            : "Waiting for storage information…"}
                    </p>
                )}
            </div>
        </div>
    );
}

type ObjectTypes = LiveOntology["ir"]["objectTypes"];

export function StorageDetails({
    status,
    objectTypes = [],
    view = "total",
}: {
    status: StorageStatus;
    objectTypes?: ObjectTypes;
    view?: StorageView;
}) {
    const [hovered, setHovered] = useState<string>();
    const [focused, setFocused] = useState<string>();
    const highlighted = hovered ?? focused;
    const objects = status.cache?.objects;
    const attachments = status.cache?.attachments;
    const parts = [
        ...(view === "attachments"
            ? []
            : objects?.byObjectType?.length
              ? objects.byObjectType.map((entry) => {
                    const type = objectTypes.find((type) => type.name === entry.objectType);
                    return {
                        label: type?.pluralDisplayName ?? entry.objectType,
                        bytes: entry.bytes,
                        color: type?.color ?? "var(--ps-muted)",
                    };
                })
              : [{ label: "Objects", bytes: objects?.bytes ?? 0, color: "var(--ps-muted)" }]),
        ...(view === "objects"
            ? []
            : [{ label: "Attachments", bytes: attachments?.bytes ?? 0, color: "var(--ps-accent)" }]),
    ].filter((entry) => entry.bytes > 0);
    const total = parts.reduce((sum, part) => sum + part.bytes, 0);
    const capacity = view === "available" ? status.capacity?.storage : undefined;
    const available = capacity?.availableBytes;
    const budget = view === "objects" ? objects : view === "attachments" ? attachments : undefined;
    const scale = Math.max(total, budget?.maxBytes ?? total + (available ?? 0));
    const freeLabel =
        available !== undefined
            ? "Available storage"
            : budget?.maxBytes !== undefined
              ? "Remaining budget"
              : undefined;
    const free =
        available ?? (budget?.maxBytes === undefined ? undefined : Math.max(0, budget.maxBytes - total));
    const chartParts = [
        ...parts,
        ...(freeLabel && free !== undefined
            ? [{ label: freeLabel, bytes: free, color: "var(--ps-hover)" }]
            : []),
    ];
    const heading =
        view === "objects" ? "Object cache" : view === "attachments" ? "Attachment cache" : "Replica cache";
    return (
        <>
            <section className="ps-storage-summary" aria-label="Replica cache usage">
                <div className="ps-storage-heading">
                    <h2>{heading}</h2>
                    <strong>
                        {status.cache ? bytes(total) : "Unavailable"}
                        {budget?.maxBytes !== undefined
                            ? ` of ${bytes(budget.maxBytes)}`
                            : available !== undefined
                              ? ` · ${bytes(available)} available`
                              : ""}
                    </strong>
                </div>
                <figure className="ps-storage-chart" aria-label="Storage by object type">
                    <div className="ps-storage-bar">
                        {chartParts.map((part) => (
                            <span
                                key={part.label}
                                title={`${part.label}: ${bytes(part.bytes)}`}
                                data-storage-part={part.label}
                                data-dimmed={highlighted !== undefined && highlighted !== part.label}
                                className={part.label === freeLabel ? "ps-storage-free" : undefined}
                                style={{
                                    width: `${scale ? (part.bytes / scale) * 100 : 0}%`,
                                    background: part.color,
                                }}
                            >
                                {part.label === freeLabel && part.bytes / scale > 0.2
                                    ? `${bytes(part.bytes)} ${available !== undefined ? "available" : "remaining"}`
                                    : ""}
                            </span>
                        ))}
                        {budget?.targetBytes !== undefined && scale > 0 && (
                            <i
                                className="ps-storage-target"
                                style={{ left: `${(budget.targetBytes / scale) * 100}%` }}
                                title={`Reclaim toward ${bytes(budget.targetBytes)}`}
                            />
                        )}
                    </div>
                </figure>
                <div className="ps-storage-legend">
                    {chartParts.map((part) => (
                        <button
                            type="button"
                            key={part.label}
                            onPointerEnter={() => setHovered(part.label)}
                            onPointerLeave={() => setHovered(undefined)}
                            onFocus={() => setFocused(part.label)}
                            onBlur={() => setFocused(undefined)}
                        >
                            <i style={{ background: part.color }} aria-hidden />
                            {part.label}
                            <strong>{bytes(part.bytes)}</strong>
                        </button>
                    ))}
                </div>
                {budget?.targetBytes !== undefined && (
                    <p className="ps-storage-budget-note">
                        Reclaim toward {bytes(budget.targetBytes)}
                        {total > (budget.maxBytes ?? Infinity) ? " · Above budget" : ""}
                    </p>
                )}
            </section>
            <p className="ps-storage-note ps-storage-footnote">
                Logical payload sizes. Database indexes, filesystem overhead and transfer buffers are
                excluded.
                {available !== undefined
                    ? capacity?.scope === "origin"
                        ? " Available storage is the browser origin’s shared free quota, not device free space."
                        : " Available storage is shared with other users of this filesystem or database."
                    : ""}
            </p>
        </>
    );
}
