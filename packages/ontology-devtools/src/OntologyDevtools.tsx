import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import { Tabs } from "@base-ui/react/tabs";
import { Tooltip } from "@base-ui/react/tooltip";
import {
    ArrowPathIcon,
    Bars2Icon,
    CalendarDaysIcon,
    CheckIcon,
    CheckCircleIcon,
    ChevronDownIcon,
    ChevronUpIcon,
    ChevronUpDownIcon,
    CircleStackIcon,
    ClockIcon,
    CodeBracketSquareIcon,
    HashtagIcon,
    InboxStackIcon,
    LinkIcon,
    ListBulletIcon,
    MapIcon,
    MapPinIcon,
    PaperClipIcon,
    QuestionMarkCircleIcon,
    ShareIcon,
    Squares2X2Icon,
    TrashIcon,
    ViewColumnsIcon,
} from "@heroicons/react/24/outline";
import NumberFlow from "@number-flow/react";
import { createReactPlugin } from "@tanstack/devtools-utils/react";
import { useLiveInfiniteQuery, useLiveQuery } from "@tanstack/react-db";
import {
    createColumnHelper,
    flexRender,
    getCoreRowModel,
    useReactTable,
    type ColumnOrderState,
    type ColumnSizingState,
    type SortingState,
    type VisibilityState,
} from "@tanstack/react-table";
import {
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    type ComponentType,
    type CSSProperties,
    type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import type {
    AttachmentMetadata,
    LiveOntology,
    OntologyDefinition,
    OntologyIR,
    OntologyOutbox,
    OntologyOutboxEntry,
    ObjectTypeDef,
    TypeDef,
} from "@party-stack/ontology";
import type * as v from "@party-stack/ontology/values";
import type { TanStackDevtoolsReactPlugin } from "@tanstack/react-devtools";
import "./styles.css";

export interface OntologyDevtoolsPanelProps<
    Ontology extends OntologyDefinition = OntologyDefinition,
> {
    ontology: LiveOntology<Ontology>;
    theme?: "light" | "dark";
}

export interface OntologyDevtoolsPluginOptions<
    Ontology extends OntologyDefinition = OntologyDefinition,
> {
    ontology: LiveOntology<Ontology>;
    id?: string;
    name?: TanStackDevtoolsReactPlugin["name"];
    defaultOpen?: boolean;
}

export interface OntologyDevtoolsChromeProps {
    theme: "light" | "dark";
}


function PartyStackLogo({ theme }: OntologyDevtoolsChromeProps) {
    const id = useId().replaceAll(":", "");
    const gradientId = `ps-ball-${id}`;
    const shadowId = `ps-shadow-${id}`;

    return (
        <svg
            aria-hidden="true"
            style={{
                display: "block",
                height: "100%",
                width: "100%",
            }}
            viewBox="0 0 1200 300"
        >
            <defs>
                <radialGradient cx="69%" cy="24%" id={gradientId} r="82%">
                    <stop offset="0" stopColor="#fff" />
                    <stop offset=".38" stopColor="#fff" />
                    <stop offset=".62" stopColor="#f8f7f3" />
                    <stop offset=".82" stopColor="#e1dfda" />
                    <stop offset="1" stopColor="#b7b3ad" />
                </radialGradient>
                <filter height="170%" id={shadowId} width="160%" x="-30%" y="-30%">
                    <feDropShadow dx="3" dy="6" floodColor="#681611" floodOpacity=".28" stdDeviation="5" />
                </filter>
            </defs>
            <g transform="translate(22 22) scale(.5)">
                <path d="M96 64h184c81 0 136 55 136 136s-55 136-136 136h-56v112H96V64Z" fill="#e83b32" />
                <g filter={`url(#${shadowId})`}>
                    <circle cx="258" cy="200" fill={`url(#${gradientId})`} r="60" />
                    <ellipse cx="279" cy="177" fill="#fff" opacity=".92" rx="8.5" ry="10.5" />
                </g>
            </g>
            <text
                fill={theme === "dark" ? "#f7f5f0" : "#171717"}
                fontFamily="Avenir Next, Avenir, Helvetica Neue, Arial, sans-serif"
                fontSize="124"
                fontWeight="700"
                letterSpacing="-3"
                x="310"
                y="196"
            >
                Party Stack
            </text>
        </svg>
    );
}

function PartyStackLogomark() {
    const id = useId().replaceAll(":", "");
    const gradientId = `ps-mark-ball-${id}`;
    const shadowId = `ps-mark-shadow-${id}`;

    return (
        <svg
            aria-hidden="true"
            style={{
                display: "block",
                height: "100%",
                width: "100%",
            }}
            viewBox="0 0 512 512"
        >
            <defs>
                <radialGradient cx="69%" cy="24%" id={gradientId} r="82%">
                    <stop offset="0" stopColor="#fff" />
                    <stop offset=".38" stopColor="#fff" />
                    <stop offset=".62" stopColor="#f8f7f3" />
                    <stop offset=".82" stopColor="#e1dfda" />
                    <stop offset="1" stopColor="#b7b3ad" />
                </radialGradient>
                <filter height="170%" id={shadowId} width="160%" x="-30%" y="-30%">
                    <feDropShadow dx="3" dy="6" floodColor="#681611" floodOpacity=".28" stdDeviation="5" />
                </filter>
            </defs>
            <path d="M96 64h184c81 0 136 55 136 136s-55 136-136 136h-56v112H96V64Z" fill="#e83b32" />
            <g filter={`url(#${shadowId})`}>
                <circle cx="258" cy="200" fill={`url(#${gradientId})`} r="60" />
                <ellipse cx="279" cy="177" fill="#fff" opacity=".92" rx="8.5" ry="10.5" />
            </g>
        </svg>
    );
}

export function OntologyDevtoolsPluginName({ theme }: OntologyDevtoolsChromeProps) {
    return (
        <div style={{ height: 30, width: 120 }}>
            <PartyStackLogo theme={theme} />
        </div>
    );
}

export function OntologyDevtoolsTrigger({ theme }: OntologyDevtoolsChromeProps) {
    const dark = theme === "dark";
    return (
        <div
            aria-label="Open Ontology devtools"
            role="button"
            style={{
                alignItems: "center",
                background: dark
                    ? "linear-gradient(145deg, #2d2d31, #171719)"
                    : "linear-gradient(145deg, #fff, #f5f5f4)",
                border: dark ? "1px solid rgba(255,255,255,.16)" : "1px solid rgba(23,23,23,.14)",
                borderRadius: "999px",
                boxShadow: dark
                    ? "0 10px 30px rgba(0,0,0,.34), 0 0 0 4px rgba(232,59,50,.11)"
                    : "0 10px 28px rgba(28,25,23,.16), 0 0 0 4px rgba(232,59,50,.09)",
                cursor: "pointer",
                display: "flex",
                height: 48,
                justifyContent: "center",
                padding: 8,
                width: 48,
            }}
            title="Open Ontology devtools"
        >
            <PartyStackLogomark />
        </div>
    );
}

export function ontologyDevtoolsTrigger(
    _element: HTMLElement,
    { theme }: OntologyDevtoolsChromeProps
) {
    return <OntologyDevtoolsTrigger theme={theme} />;
}

function OutboxPanel({ children, theme }: { children: ReactNode; theme: "light" | "dark" }) {
    return (
        <div className={`ps-outbox-root ps-theme-${theme}`}>
            <div className="ps-outbox">
                {children}
            </div>
        </div>
    );
}

function statusClass(entry: OntologyOutboxEntry): string {
    return `ps-outbox-status ps-status-${entry.status}`;
}

function statusLabel(entry: OntologyOutboxEntry): string {
    switch (entry.status) {
        case "queued":
            return "Waiting";
        case "executing":
            return "Running";
        case "failed":
            return "Failed";
    }
}

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function formatRelativeTime(timestamp: number, now: number): string {
    const elapsedMs = Math.max(0, now - timestamp);
    if (elapsedMs < 60_000) {
        return "a few seconds ago";
    }
    const minutes = -Math.round(elapsedMs / 60_000);
    if (Math.abs(minutes) < 60) {
        return relativeTime.format(minutes, "minute");
    }
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) {
        return relativeTime.format(hours, "hour");
    }
    return relativeTime.format(Math.round(hours / 24), "day");
}

function useRelativeTimeNow(): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const interval = setInterval(() => {
            setNow(Date.now());
        }, 60_000);
        return () => {
            clearInterval(interval);
        };
    }, []);
    return now;
}

function cardClass(entry: OntologyOutboxEntry): string {
    return `ps-outbox-card ps-card-${entry.status}`;
}

function OutboxEntryCard({
    entry,
    outbox,
    now,
}: {
    entry: OntologyOutboxEntry;
    outbox: OntologyOutbox;
    now: number;
}) {
    const [pending, setPending] = useState<"retry" | "remove" | undefined>();
    const [actionError, setActionError] = useState<string>();

    const run = async (action: "retry" | "remove"): Promise<void> => {
        setPending(action);
        setActionError(undefined);
        try {
            if (action === "retry") {
                await outbox.retry(entry.id);
            } else {
                await outbox.remove(entry.id);
            }
        } catch (error) {
            setActionError(error instanceof Error ? error.message : String(error));
        } finally {
            setPending(undefined);
        }
    };

    return (
        <article className={cardClass(entry)}>
            <div className="ps-outbox-card-header">
                <div className="ps-outbox-name">{entry.request.actionTypeName}</div>
                <span className={statusClass(entry)}>
                    <span className="ps-status-dot" />
                    {statusLabel(entry)}
                </span>
            </div>
            <div className="ps-outbox-meta">
                <span>
                    <strong>{entry.attempts}</strong> {entry.attempts === 1 ? "attempt" : "attempts"}
                </span>
                <span aria-hidden="true" className="ps-outbox-meta-divider" />
                <span className="ps-outbox-time" title={new Date(entry.createdAt).toLocaleString()}>
                    Queued {formatRelativeTime(entry.createdAt, now)}
                </span>
                {!entry.retryable ? <span className="ps-outbox-permanent">Won&apos;t retry</span> : null}
            </div>
            {entry.lastError ? <div className="ps-outbox-error">{entry.lastError.message}</div> : null}
            <details className="ps-outbox-details">
                <summary>Parameters</summary>
                <pre>{JSON.stringify(entry.request.parameters, null, 2)}</pre>
            </details>
            <div className="ps-outbox-actions">
                <button
                    className="ps-button ps-button-primary"
                    type="button"
                    disabled={!entry.retryable || entry.status === "executing" || pending !== undefined}
                    onClick={() => {
                        void run("retry");
                    }}
                >
                    <ArrowPathIcon aria-hidden="true" />
                    {pending === "retry" ? "Retrying…" : "Retry"}
                </button>
                <button
                    className="ps-button ps-button-danger"
                    type="button"
                    disabled={entry.status === "executing" || pending !== undefined}
                    onClick={() => {
                        void run("remove");
                    }}
                >
                    <TrashIcon aria-hidden="true" />
                    {pending === "remove" ? "Removing…" : "Remove"}
                </button>
            </div>
            {actionError ? <div className="ps-outbox-action-error">{actionError}</div> : null}
        </article>
    );
}

function outboxSnapshotKey(entries: OntologyOutboxEntry[]): string {
    return entries
        .map((entry) => `${entry.id}:${entry.status}:${entry.updatedAt}:${entry.attempts}`)
        .join("|");
}

function useTransitionedEntries(entries: OntologyOutboxEntry[]): OntologyOutboxEntry[] {
    const [visibleEntries, setVisibleEntries] = useState(entries);
    const snapshotKey = outboxSnapshotKey(entries);
    const previousKey = useRef(snapshotKey);

    useEffect(() => {
        if (snapshotKey === previousKey.current) {
            return;
        }
        previousKey.current = snapshotKey;
        let cancelled = false;

        queueMicrotask(() => {
            if (cancelled) return;
            if (
                window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
                !document.startViewTransition
            ) {
                setVisibleEntries(entries);
                return;
            }

            document.documentElement.dataset.psOutboxTransition = "";
            try {
                const transition = document.startViewTransition(() => {
                    flushSync(() => {
                        setVisibleEntries(entries);
                    });
                });
                void transition.finished.finally(() => {
                    delete document.documentElement.dataset.psOutboxTransition;
                });
            } catch {
                delete document.documentElement.dataset.psOutboxTransition;
                setVisibleEntries(entries);
            }
        });

        return () => {
            cancelled = true;
        };
    }, [entries, snapshotKey]);

    return visibleEntries;
}

function OutboxRows({ outbox, theme }: { outbox: OntologyOutbox; theme: "light" | "dark" }) {
    const now = useRelativeTimeNow();
    const transitionScope = `ps-outbox-${useId().replaceAll(":", "")}`;
    const { data } = useLiveQuery(
        (query) => query.from({ entry: outbox.collection }).orderBy(({ entry }) => entry.sequence, "asc"),
        [outbox]
    );
    const visibleData = useTransitionedEntries(data);

    return (
        <OutboxPanel theme={theme}>
            {visibleData.length === 0 ? (
                <div
                    className="ps-outbox-empty"
                    style={{
                        viewTransitionName: `${transitionScope}-empty`,
                    }}
                >
                    <div>
                        <span className="ps-outbox-empty-mark">
                            <CheckIcon aria-hidden="true" />
                        </span>
                        <strong>Queue is clear</strong>
                        Actions will appear here while they wait to sync.
                    </div>
                </div>
            ) : (
                <div className="ps-outbox-track">
                    {visibleData.map((entry, index) => (
                        <div
                            className="ps-outbox-step"
                            key={entry.id}
                            style={{
                                viewTransitionName: `${transitionScope}-entry-${entry.id.replaceAll(
                                    /[^a-zA-Z0-9_-]/g,
                                    "-"
                                )}`,
                            }}
                        >
                            {index > 0 ? <span aria-hidden="true" className="ps-outbox-connector" /> : null}
                            <div className="ps-outbox-node">
                                <OutboxEntryCard entry={entry} now={now} outbox={outbox} />
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </OutboxPanel>
    );
}

type OntologyDevtoolsView = "objects" | "schema" | "outbox";
type OutboxActivity = "idle" | "draining" | "paused";

export function getOutboxActivity(entries: OntologyOutboxEntry[]): OutboxActivity {
    if (entries.length === 0) return "idle";
    const head = entries.reduce((first, entry) =>
        entry.sequence < first.sequence ? entry : first
    );
    if (head.status === "failed") return "paused";
    return "draining";
}

function outboxActivityLabel(activity: OutboxActivity): string {
    switch (activity) {
        case "idle":
            return "Idle";
        case "draining":
            return "Draining";
        case "paused":
            return "Paused by failure";
    }
}

function outboxBadgeClass(activity: OutboxActivity): string {
    switch (activity) {
        case "idle":
            return "ps:bg-zinc-500/15 ps:text-zinc-400";
        case "draining":
            return "ps:bg-sky-500/20 ps:text-sky-300";
        case "paused":
            return "ps:bg-red-500/20 ps:text-red-300";
    }
}

const ontologyViews: Array<{
    id: OntologyDevtoolsView;
    label: string;
    icon: ComponentType<{
        "aria-hidden"?: boolean;
        className?: string;
        style?: CSSProperties;
    }>;
}> = [
    { id: "outbox", label: "Outbox", icon: InboxStackIcon },
    { id: "schema", label: "Schema", icon: ShareIcon },
    { id: "objects", label: "Objects", icon: CircleStackIcon },
];

function formatObjectValue(value: unknown): string {
    if (value === undefined || value === null) return "—";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return String(value);
    }
    try {
        return JSON.stringify(value);
    } catch {
        return "[Unserializable value]";
    }
}

const CONTINENTS = [
    "15,25 45,20 75,22 110,30 120,35 105,52 100,62 85,68 75,72 60,65 50,42 30,35",
    "100,82 118,80 138,90 140,100 130,118 118,132 108,138 100,122 95,100",
    "175,38 185,30 198,28 208,32 205,42 198,48 188,48 178,44",
    "170,58 185,52 205,56 218,68 215,88 208,108 198,125 185,128 172,112 168,88 165,70",
    "212,42 228,32 255,22 282,18 310,22 325,30 330,42 318,55 300,58 282,65 265,78 248,72 232,58 218,50",
    "292,112 312,108 332,114 330,126 318,134 298,128 292,118",
];

function resolvedType(ir: OntologyIR, type: TypeDef): TypeDef {
    if (type.kind !== "ref") return type;
    const referenced = ir.types.find((candidate) => candidate.name === type.value.name)?.type;
    return referenced ? resolvedType(ir, referenced) : type;
}

export function typeDisplayName(ir: OntologyIR, type: TypeDef): string {
    switch (type.kind) {
        case "ref":
            return type.value.name;
        case "optional":
            return `${typeDisplayName(ir, type.value.type)} (optional)`;
        case "list":
            return `List of ${typeDisplayName(ir, type.value.elementType)}`;
        case "map":
            return `Map of ${typeDisplayName(ir, type.value.valueType)}`;
        case "objectReference":
            return `${type.value.objectType} reference`;
        case "string":
            return "String";
        case "boolean":
            return "Boolean";
        case "integer":
            return "Integer";
        case "float":
            return "Float";
        case "double":
            return "Double";
        case "date":
            return "Date";
        case "timestamp":
            return "Timestamp";
        case "geopoint":
            return "Geopoint";
        case "struct":
            return "Struct";
        case "union":
            return "Union";
        case "result":
            return "Result";
        case "attachment":
            return "Attachment";
        case "unknown":
            return "Unknown";
    }
}

function typeIcon(type: TypeDef): ComponentType<{ "aria-hidden"?: boolean; className?: string }> {
    switch (type.kind) {
        case "ref":
            return LinkIcon;
        case "optional":
            return typeIcon(type.value.type);
        case "list":
            return ListBulletIcon;
        case "map":
            return Squares2X2Icon;
        case "objectReference":
            return LinkIcon;
        case "string":
            return CodeBracketSquareIcon;
        case "boolean":
            return CheckCircleIcon;
        case "integer":
        case "float":
        case "double":
            return HashtagIcon;
        case "date":
            return CalendarDaysIcon;
        case "timestamp":
            return ClockIcon;
        case "geopoint":
            return MapPinIcon;
        case "attachment":
            return PaperClipIcon;
        case "struct":
        case "union":
        case "result":
            return MapIcon;
        case "unknown":
            return QuestionMarkCircleIcon;
    }
}

function DevtoolsTooltip({ children, label }: { children: ReactNode; label: ReactNode }) {
    return (
        <Tooltip.Root>
            <Tooltip.Trigger render={<span className="ps:inline-flex ps:items-center" />}>
                {children}
            </Tooltip.Trigger>
            <Tooltip.Portal>
                <Tooltip.Positioner className="ps:z-[100001]" sideOffset={6}>
                    <Tooltip.Popup className="ps:max-w-64 ps:rounded-md ps:border ps:border-zinc-700 ps:bg-zinc-900 ps:px-2.5 ps:py-1.5 ps:text-[11px] ps:text-zinc-200 ps:shadow-xl">
                        {label}
                    </Tooltip.Popup>
                </Tooltip.Positioner>
            </Tooltip.Portal>
        </Tooltip.Root>
    );
}

function TypeIndicator({ ir, type }: { ir: OntologyIR; type: TypeDef }) {
    const Icon = typeIcon(type);
    return (
        <DevtoolsTooltip label={typeDisplayName(ir, type)}>
            <Icon aria-hidden className="ps:size-3.5 ps:text-zinc-500" />
        </DevtoolsTooltip>
    );
}

function isGeopoint(value: unknown): value is v.geopoint {
    return (
        typeof value === "object" &&
        value !== null &&
        "lat" in value &&
        typeof value.lat === "number" &&
        "lon" in value &&
        typeof value.lon === "number"
    );
}

function GeopointPreview({ value }: { value: v.geopoint }) {
    const cx = value.lon + 180;
    const cy = 90 - value.lat;
    const label = `${value.lat.toFixed(4)}, ${value.lon.toFixed(4)}`;
    return (
        <DevtoolsTooltip
            label={
                <svg
                    aria-label={`Map preview for ${label}`}
                    className="ps:block ps:rounded ps:border ps:border-zinc-700"
                    height="72"
                    role="img"
                    viewBox="0 0 360 180"
                    width="144"
                >
                    <rect className="ps:fill-sky-950" height="180" width="360" />
                    {CONTINENTS.map((points) => (
                        <polygon
                            className="ps:fill-zinc-700 ps:stroke-zinc-600"
                            key={points}
                            points={points}
                            strokeWidth="0.5"
                        />
                    ))}
                    <circle className="ps:fill-rose-400" cx={cx} cy={cy} r="5" />
                </svg>
            }
        >
            <a
                className="ps:text-sky-400 ps:underline ps:decoration-dotted ps:underline-offset-4"
                href={`https://www.google.com/maps?q=${value.lat},${value.lon}`}
                rel="noopener noreferrer"
                target="_blank"
            >
                {label}
            </a>
        </DevtoolsTooltip>
    );
}

export function timestampPreview(value: unknown): { display: string; exact: string } | undefined {
    if (value === undefined || value === null) return undefined;
    const exact = formatObjectValue(value);
    let epochMilliseconds: number | undefined;
    if (value instanceof Date) {
        epochMilliseconds = value.getTime();
    } else if (
        typeof value === "object" &&
        "epochMilliseconds" in value &&
        (typeof value.epochMilliseconds === "number" ||
            typeof value.epochMilliseconds === "bigint")
    ) {
        epochMilliseconds = Number(value.epochMilliseconds);
    } else if (typeof value === "string") {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) epochMilliseconds = parsed;
    }
    if (epochMilliseconds === undefined || !Number.isFinite(epochMilliseconds)) {
        return { display: exact, exact };
    }
    return {
        display: new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "medium",
        }).format(new Date(epochMilliseconds)),
        exact,
    };
}

function isAttachment(value: unknown): value is v.attachment {
    return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string";
}

function AttachmentPreview({
    attachment,
    ontology,
}: {
    attachment: v.attachment;
    ontology: LiveOntology;
}) {
    const [preview, setPreview] = useState<{
        metadata: AttachmentMetadata;
        src?: string;
    }>();
    useEffect(() => {
        let cancelled = false;
        let objectUrl: string | undefined;
        void ontology.attachments
            .metadata(attachment)
            .then(async (metadata) => {
                if (metadata.type.startsWith("image/")) {
                    objectUrl = URL.createObjectURL(await ontology.attachments.blob(attachment));
                }
                if (!cancelled) setPreview({ metadata, src: objectUrl });
            })
            .catch(() => {
                if (!cancelled) setPreview(undefined);
            });
        return () => {
            cancelled = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [attachment, ontology]);

    const label = preview?.metadata.name ?? attachment.id;
    if (!preview?.src) {
        return (
            <DevtoolsTooltip label={label}>
                <span className="ps:inline-flex ps:max-w-40 ps:items-center ps:gap-1.5 ps:truncate">
                    <PaperClipIcon aria-hidden className="ps:size-3.5 ps:flex-none ps:text-zinc-500" />
                    <span className="ps:truncate">{label}</span>
                </span>
            </DevtoolsTooltip>
        );
    }

    return (
        <Dialog.Root>
            <Dialog.Trigger
                aria-label={`Open ${label}`}
                className="ps:block ps:overflow-hidden ps:rounded-md ps:border ps:border-zinc-700 ps:bg-transparent ps:p-0 ps:hover:border-rose-400"
            >
                <img alt={label} className="ps:size-10 ps:object-cover" src={preview.src} />
            </Dialog.Trigger>
            <Dialog.Portal>
                <Dialog.Backdrop className="ps:fixed ps:inset-0 ps:z-[100002] ps:bg-black/75 ps:backdrop-blur-sm" />
                <Dialog.Viewport className="ps:fixed ps:inset-0 ps:z-[100003] ps:grid ps:place-items-center ps:p-8">
                    <Dialog.Popup className="ps:relative ps:max-h-full ps:max-w-4xl ps:rounded-xl ps:border ps:border-zinc-700 ps:bg-zinc-950 ps:p-3 ps:shadow-2xl">
                        <Dialog.Title className="ps:sr-only">{label}</Dialog.Title>
                        <img
                            alt={label}
                            className="ps:max-h-[80vh] ps:max-w-[80vw] ps:rounded-lg ps:object-contain"
                            src={preview.src}
                        />
                        <Dialog.Close className="ps:absolute ps:top-4 ps:right-4 ps:rounded-md ps:border ps:border-zinc-600 ps:bg-zinc-950/90 ps:px-2.5 ps:py-1.5 ps:text-xs ps:text-white">
                            Close
                        </Dialog.Close>
                    </Dialog.Popup>
                </Dialog.Viewport>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

function PropertyValuePreview({
    ir,
    ontology,
    type,
    value,
}: {
    ir: OntologyIR;
    ontology: LiveOntology;
    type: TypeDef;
    value: unknown;
}) {
    const resolved = resolvedType(ir, type);
    if (resolved.kind === "optional") {
        return (
            <PropertyValuePreview
                ir={ir}
                ontology={ontology}
                type={resolved.value.type}
                value={value}
            />
        );
    }
    if (resolved.kind === "geopoint" && isGeopoint(value)) {
        return <GeopointPreview value={value} />;
    }
    if (resolved.kind === "timestamp") {
        const preview = timestampPreview(value);
        if (preview) {
            return (
                <DevtoolsTooltip label={preview.exact}>
                    <span>{preview.display}</span>
                </DevtoolsTooltip>
            );
        }
    }
    if (resolved.kind === "attachment" && isAttachment(value)) {
        return <AttachmentPreview attachment={value} ontology={ontology} />;
    }
    if (
        resolved.kind === "list" &&
        resolvedType(ir, resolved.value.elementType).kind === "attachment" &&
        Array.isArray(value)
    ) {
        const attachments = value.filter(isAttachment);
        if (attachments.length > 0) {
            return (
                <div className="ps:flex ps:items-center ps:gap-1.5">
                    {attachments.slice(0, 3).map((attachment) => (
                        <AttachmentPreview
                            attachment={attachment}
                            key={attachment.id}
                            ontology={ontology}
                        />
                    ))}
                    {attachments.length > 3 ? (
                        <span className="ps:text-zinc-500">+{attachments.length - 3}</span>
                    ) : null}
                </div>
            );
        }
    }
    const formatted = formatObjectValue(value);
    return (
        <span className="ps:block ps:max-w-72 ps:truncate" title={formatted}>
            {formatted}
        </span>
    );
}

function defaultColumnSize(ir: OntologyIR, type: TypeDef): number {
    switch (resolvedType(ir, type).kind) {
        case "boolean":
            return 110;
        case "integer":
        case "float":
        case "double":
            return 130;
        case "date":
        case "timestamp":
            return 190;
        case "geopoint":
            return 175;
        case "attachment":
        case "list":
            return 150;
        case "objectReference":
            return 200;
        case "string":
            return 220;
        default:
            return 180;
    }
}

export function moveColumn(
    columnOrder: string[],
    sourceId: string,
    targetId: string
): string[] {
    const sourceIndex = columnOrder.indexOf(sourceId);
    const targetIndex = columnOrder.indexOf(targetId);
    if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
        return columnOrder;
    }
    const next = [...columnOrder];
    next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, sourceId);
    return next;
}

const objectColumnHelper = createColumnHelper<Record<string, unknown>>();

function ObjectTable({
    collection,
    objectType,
    ontology,
}: {
    collection: LiveOntology["objects"][string];
    objectType: ObjectTypeDef;
    ontology: LiveOntology;
}) {
    const [sorting, setSorting] = useState<SortingState>([]);
    const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
    const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
    const [columnOrder, setColumnOrder] = useState<ColumnOrderState>(() =>
        objectType.properties.map((property) => property.name)
    );
    const [draggedColumnId, setDraggedColumnId] = useState<string>();
    const [dragOverColumnId, setDragOverColumnId] = useState<string>();
    const selectedSort = sorting[0];
    const {
        data,
        fetchNextPage,
        hasNextPage,
        isFetchingNextPage,
    } = useLiveInfiniteQuery(
        (query) => {
            const from = query.from({ row: collection });
            const primaryKey = objectType.primaryKey;
            if (selectedSort && selectedSort.id !== primaryKey) {
                return from
                    .orderBy(
                        ({ row }) =>
                            (row as Record<string, unknown>)[selectedSort.id] as string | number,
                        selectedSort.desc ? "desc" : "asc"
                    )
                    .orderBy(
                        ({ row }) =>
                            (row as Record<string, unknown>)[primaryKey] as string | number,
                        "asc"
                    )
                    .select(({ row }) => row as Record<string, unknown>);
            }
            return from
                .orderBy(
                    ({ row }) =>
                        (row as Record<string, unknown>)[primaryKey] as string | number,
                    selectedSort?.desc ? "desc" : "asc"
                )
                .select(({ row }) => row as Record<string, unknown>);
        },
        { pageSize: 50 },
        [collection.id, objectType.primaryKey, selectedSort?.id, selectedSort?.desc]
    );
    const rows = data as Array<Record<string, unknown>>;
    const columns = useMemo(
        () =>
            objectType.properties.map((property) =>
                objectColumnHelper.accessor((row) => row[property.name], {
                    id: property.name,
                    maxSize: 520,
                    minSize: 90,
                    size:
                        property.name === objectType.primaryKey
                            ? 220
                            : defaultColumnSize(ontology.ir, property.type),
                    header: () => (
                        <span className="ps:inline-flex ps:items-center ps:gap-1.5">
                            <TypeIndicator ir={ontology.ir} type={property.type} />
                            <span>{property.displayName}</span>
                            {property.name === objectType.primaryKey ? (
                                <span className="ps:ml-1.5 ps:text-[9px] ps:font-bold ps:tracking-wide ps:text-rose-400">
                                    PK
                                </span>
                            ) : null}
                        </span>
                    ),
                    cell: (info) => (
                        <PropertyValuePreview
                            ir={ontology.ir}
                            ontology={ontology}
                            type={property.type}
                            value={info.getValue()}
                        />
                    ),
                })
            ),
        [objectType, ontology]
    );
    const table = useReactTable({
        columnResizeMode: "onEnd",
        columns,
        data: rows,
        enableColumnResizing: true,
        getCoreRowModel: getCoreRowModel(),
        getRowId: (row, index) => `${formatObjectValue(row[objectType.primaryKey])}-${index}`,
        manualSorting: true,
        onColumnOrderChange: setColumnOrder,
        onColumnSizingChange: setColumnSizing,
        onColumnVisibilityChange: setColumnVisibility,
        onSortingChange: setSorting,
        state: { columnOrder, columnSizing, columnVisibility, sorting },
    });
    const resizingColumnId = table.getState().columnSizingInfo.isResizingColumn;
    const resizingColumn =
        typeof resizingColumnId === "string" ? table.getColumn(resizingColumnId) : undefined;
    const allColumns = table.getAllLeafColumns();

    return (
        <div className="ps:flex ps:min-h-0 ps:min-w-0 ps:flex-1 ps:flex-col ps:overflow-hidden">
            <div className="ps:flex ps:flex-none ps:items-center ps:border-b ps:border-zinc-500/20 ps:px-4 ps:py-2">
                <h2 className="ps:m-0 ps:text-lg ps:font-semibold">{objectType.pluralDisplayName}</h2>
                <div className="ps:ml-auto ps:flex ps:items-center ps:gap-1.5">
                    <button
                        className="ps:inline-flex ps:items-center ps:gap-1.5 ps:rounded-md ps:border-0 ps:bg-transparent ps:px-2 ps:py-1.5 ps:text-xs ps:text-zinc-400 ps:hover:bg-zinc-500/10 ps:hover:text-current ps:disabled:opacity-40"
                        disabled={Object.keys(columnSizing).length === 0}
                        title="Reset column widths"
                        type="button"
                        onClick={() => {
                            table.resetColumnSizing();
                        }}
                    >
                        <ArrowPathIcon aria-hidden className="ps:size-3.5" />
                        Reset widths
                    </button>
                    <Menu.Root>
                        <Menu.Trigger className="ps:inline-flex ps:items-center ps:gap-1.5 ps:rounded-md ps:border ps:border-zinc-500/30 ps:bg-zinc-500/10 ps:px-2.5 ps:py-1.5 ps:text-xs ps:text-inherit ps:hover:border-zinc-500/60">
                            <ViewColumnsIcon aria-hidden className="ps:size-3.5" />
                            Columns
                        </Menu.Trigger>
                        <Menu.Portal>
                            <Menu.Positioner
                                align="end"
                                className="ps:z-[100001]"
                                sideOffset={6}
                            >
                                <Menu.Popup className="ps:min-w-48 ps:rounded-lg ps:border ps:border-zinc-700 ps:bg-zinc-900 ps:p-1.5 ps:text-xs ps:text-zinc-200 ps:shadow-2xl">
                                    <Menu.Group>
                                        <Menu.GroupLabel className="ps:px-2 ps:py-1.5 ps:text-[10px] ps:font-bold ps:tracking-wider ps:text-zinc-500 ps:uppercase">
                                            Columns
                                        </Menu.GroupLabel>
                                        {allColumns.map((column, columnIndex) => (
                                            <Menu.CheckboxItem
                                                aria-label={
                                                    objectType.properties.find(
                                                        (property) =>
                                                            property.name === column.id
                                                    )?.displayName ?? column.id
                                                }
                                                checked={column.getIsVisible()}
                                                className={
                                                    dragOverColumnId === column.id &&
                                                    draggedColumnId !== column.id
                                                        ? "ps:flex ps:cursor-default ps:items-center ps:gap-2 ps:rounded-md ps:bg-rose-500/15 ps:px-2 ps:py-1.5 ps:outline-none"
                                                        : "ps:flex ps:cursor-default ps:items-center ps:gap-2 ps:rounded-md ps:px-2 ps:py-1.5 ps:outline-none ps:data-[highlighted]:bg-zinc-700/70"
                                                }
                                                draggable
                                                key={column.id}
                                                label={
                                                    objectType.properties.find(
                                                        (property) =>
                                                            property.name === column.id
                                                    )?.displayName ?? column.id
                                                }
                                                onCheckedChange={(checked) => {
                                                    column.toggleVisibility(checked);
                                                }}
                                                onDragEnd={() => {
                                                    setDraggedColumnId(undefined);
                                                    setDragOverColumnId(undefined);
                                                }}
                                                onDragOver={(event) => {
                                                    event.preventDefault();
                                                    event.dataTransfer.dropEffect = "move";
                                                    setDragOverColumnId(column.id);
                                                }}
                                                onDragStart={(event) => {
                                                    event.dataTransfer.effectAllowed = "move";
                                                    event.dataTransfer.setData(
                                                        "text/plain",
                                                        column.id
                                                    );
                                                    setDraggedColumnId(column.id);
                                                }}
                                                onDrop={(event) => {
                                                    event.preventDefault();
                                                    if (
                                                        draggedColumnId &&
                                                        draggedColumnId !== column.id
                                                    ) {
                                                        setColumnOrder((current) =>
                                                            moveColumn(
                                                                current,
                                                                draggedColumnId,
                                                                column.id
                                                            )
                                                        );
                                                    }
                                                    setDraggedColumnId(undefined);
                                                    setDragOverColumnId(undefined);
                                                }}
                                                onKeyDown={(event) => {
                                                    if (
                                                        !event.altKey ||
                                                        (event.key !== "ArrowUp" &&
                                                            event.key !== "ArrowDown")
                                                    ) {
                                                        return;
                                                    }
                                                    event.preventDefault();
                                                    const targetIndex =
                                                        event.key === "ArrowUp"
                                                            ? columnIndex - 1
                                                            : columnIndex + 1;
                                                    const target = allColumns[targetIndex];
                                                    if (target) {
                                                        setColumnOrder((current) =>
                                                            moveColumn(
                                                                current,
                                                                column.id,
                                                                target.id
                                                            )
                                                        );
                                                    }
                                                }}
                                            >
                                                <span
                                                    className="ps:cursor-grab ps:text-zinc-500 ps:active:cursor-grabbing"
                                                    title="Drag to reorder"
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                    }}
                                                >
                                                    <Bars2Icon
                                                        aria-hidden
                                                        className="ps:size-3.5"
                                                    />
                                                </span>
                                                <span className="ps:grid ps:size-4 ps:place-items-center ps:rounded ps:border ps:border-zinc-600">
                                                    {column.getIsVisible() ? (
                                                        <CheckIcon
                                                            aria-hidden
                                                            className="ps:size-3 ps:text-rose-400"
                                                        />
                                                    ) : null}
                                                </span>
                                                <span className="ps:truncate">
                                                    {objectType.properties.find(
                                                        (property) => property.name === column.id
                                                    )?.displayName ?? column.id}
                                                </span>
                                            </Menu.CheckboxItem>
                                        ))}
                                        <p className="ps:m-0 ps:px-2 ps:pt-2 ps:pb-1 ps:text-[10px] ps:text-zinc-500">
                                            Drag to reorder · Alt+↑/↓ with keyboard
                                        </p>
                                    </Menu.Group>
                                </Menu.Popup>
                            </Menu.Positioner>
                        </Menu.Portal>
                    </Menu.Root>
                </div>
            </div>
            {rows.length === 0 ? (
                <div className="ps:m-4 ps:grid ps:min-h-40 ps:place-items-center ps:rounded-xl ps:border ps:border-dashed ps:border-zinc-500/40 ps:text-sm ps:text-zinc-500">
                    No objects loaded
                </div>
            ) : (
                <div className="ps-object-table-scroll ps:min-h-0 ps:flex-1 ps:overflow-auto">
                    <div
                        className="ps:relative ps:min-h-full"
                        style={{ minWidth: "100%", width: table.getTotalSize() }}
                    >
                        <table className="ps:w-full ps:table-fixed ps:border-separate ps:border-spacing-0 ps:text-left ps:text-xs">
                            <colgroup>
                                {table.getVisibleLeafColumns().map((column) => (
                                    <col key={column.id} style={{ width: column.getSize() }} />
                                ))}
                            </colgroup>
                            <thead className="ps-object-table-header">
                            {table.getHeaderGroups().map((headerGroup) => (
                                <tr key={headerGroup.id}>
                                    {headerGroup.headers.map((header) => {
                                        const direction = header.column.getIsSorted();
                                        return (
                                            <th
                                                className="ps:relative ps:border-b ps:border-zinc-500/30 ps:bg-zinc-950/95 ps:px-4 ps:py-3 ps:font-semibold ps:whitespace-nowrap ps:backdrop-blur ps:in-[.ps-theme-light]:bg-stone-50/95"
                                                key={header.id}
                                            >
                                                {header.isPlaceholder ? null : (
                                                    <button
                                                        className="ps:flex ps:w-full ps:items-center ps:gap-2 ps:border-0 ps:bg-transparent ps:p-0 ps:text-left ps:text-inherit ps:font-inherit ps:hover:text-rose-400"
                                                        title={`Sort by ${header.column.id}`}
                                                        type="button"
                                                        onClick={header.column.getToggleSortingHandler()}
                                                    >
                                                        {flexRender(
                                                            header.column.columnDef.header,
                                                            header.getContext()
                                                        )}
                                                        {direction === "asc" ? (
                                                            <ChevronUpIcon
                                                                aria-hidden
                                                                className="ps:size-3.5 ps:flex-none ps:text-rose-400"
                                                            />
                                                        ) : direction === "desc" ? (
                                                            <ChevronDownIcon
                                                                aria-hidden
                                                                className="ps:size-3.5 ps:flex-none ps:text-rose-400"
                                                            />
                                                        ) : (
                                                            <ChevronUpDownIcon
                                                                aria-hidden
                                                                className="ps:size-3.5 ps:flex-none ps:text-zinc-600"
                                                            />
                                                        )}
                                                        <span className="ps:sr-only">
                                                            {direction === "asc"
                                                                ? "Sorted ascending"
                                                                : direction === "desc"
                                                                  ? "Sorted descending"
                                                                  : "Not sorted"}
                                                        </span>
                                                    </button>
                                                )}
                                                {header.column.getCanResize() ? (
                                                    <button
                                                        aria-label={`Resize ${header.column.id} column`}
                                                        aria-orientation="vertical"
                                                        aria-valuemax={header.column.columnDef.maxSize}
                                                        aria-valuemin={header.column.columnDef.minSize}
                                                        aria-valuenow={header.column.getSize()}
                                                        className={
                                                            header.column.getIsResizing()
                                                                ? "ps:absolute ps:top-0 ps:right-0 ps:z-20 ps:h-full ps:w-1 ps:cursor-col-resize ps:touch-none ps:border-0 ps:bg-transparent ps:p-0"
                                                                : resizingColumn
                                                                  ? "ps:pointer-events-none ps:invisible ps:absolute ps:top-0 ps:right-0 ps:h-full ps:w-1 ps:border-0 ps:bg-transparent ps:p-0"
                                                                : "ps:absolute ps:top-0 ps:right-0 ps:h-full ps:w-1 ps:cursor-col-resize ps:touch-none ps:border-0 ps:bg-transparent ps:p-0 ps:hover:bg-rose-400/70 ps:focus-visible:bg-rose-400/70 ps:focus:outline-none"
                                                        }
                                                        disabled={
                                                            resizingColumn !== undefined &&
                                                            !header.column.getIsResizing()
                                                        }
                                                        role="separator"
                                                        tabIndex={0}
                                                        type="button"
                                                        onDoubleClick={() => {
                                                            header.column.resetSize();
                                                        }}
                                                        onKeyDown={(event) => {
                                                            if (
                                                                event.key !== "ArrowLeft" &&
                                                                event.key !== "ArrowRight"
                                                            ) {
                                                                return;
                                                            }
                                                            event.preventDefault();
                                                            const delta =
                                                                event.key === "ArrowRight" ? 10 : -10;
                                                            const min =
                                                                header.column.columnDef.minSize ?? 20;
                                                            const max =
                                                                header.column.columnDef.maxSize ??
                                                                Number.MAX_SAFE_INTEGER;
                                                            setColumnSizing((current) => ({
                                                                ...current,
                                                                [header.column.id]: Math.min(
                                                                    max,
                                                                    Math.max(
                                                                        min,
                                                                        header.column.getSize() +
                                                                            delta
                                                                    )
                                                                ),
                                                            }));
                                                        }}
                                                        onMouseDown={header.getResizeHandler()}
                                                        onTouchStart={header.getResizeHandler()}
                                                    />
                                                ) : null}
                                            </th>
                                        );
                                    })}
                                </tr>
                            ))}
                            </thead>
                            <tbody>
                            {table.getRowModel().rows.map((row) => (
                                <tr className="ps:hover:bg-zinc-500/8" key={row.id}>
                                    {row.getVisibleCells().map((cell) => (
                                        <td
                                            className="ps:max-w-80 ps:border-b ps:border-zinc-500/15 ps:px-4 ps:py-3 ps:text-[11px] ps:whitespace-nowrap"
                                            key={cell.id}
                                        >
                                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                            </tbody>
                        </table>
                        {hasNextPage ? (
                            <div className="ps:sticky ps:left-0 ps:flex ps:w-full ps:justify-center ps:border-t ps:border-zinc-500/20 ps:bg-zinc-950/95 ps:p-3 ps:in-[.ps-theme-light]:bg-stone-50/95">
                                <button
                                    className="ps:rounded-md ps:border ps:border-zinc-600 ps:bg-zinc-900 ps:px-3 ps:py-1.5 ps:text-xs ps:text-zinc-200 ps:hover:border-rose-400 ps:hover:text-rose-300 ps:disabled:opacity-50"
                                    disabled={isFetchingNextPage}
                                    type="button"
                                    onClick={fetchNextPage}
                                >
                                    {isFetchingNextPage ? "Loading…" : "Load 50 more"}
                                </button>
                            </div>
                        ) : null}
                        {resizingColumn ? (
                            <div
                                className="ps:pointer-events-none ps:absolute ps:inset-y-0 ps:z-50 ps:w-0.5 ps:bg-rose-400 ps:shadow-[0_0_0_1px_rgba(251,113,133,0.18)] ps:will-change-transform"
                                style={{
                                    left: resizingColumn.getStart() + resizingColumn.getSize(),
                                    transform: `translateX(${
                                        table.getState().columnSizingInfo.deltaOffset ?? 0
                                    }px)`,
                                }}
                            />
                        ) : null}
                    </div>
                </div>
            )}
        </div>
    );
}

function ObjectsView({ ontology }: { ontology: LiveOntology }) {
    const objectTypes = ontology.ir.objectTypes;
    const [selectedName, setSelectedName] = useState(() => objectTypes[0]?.name);
    const selected = objectTypes.find((objectType) => objectType.name === selectedName) ?? objectTypes[0];
    const collection = selected ? ontology.objects[selected.name] : undefined;

    if (!selected || !collection) {
        return (
            <div className="ps:grid ps:h-full ps:place-items-center ps:text-sm ps:text-zinc-500">
                This ontology has no object types.
            </div>
        );
    }

    return (
        <div className="ps:flex ps:h-full ps:min-h-0 ps:w-full ps:min-w-0 ps:overflow-hidden">
            <aside className="ps:w-44 ps:flex-none ps:overflow-y-auto ps:border-r ps:border-zinc-500/20 ps:p-3">
                <p className="ps:mt-0 ps:mb-2 ps:px-2 ps:text-[10px] ps:font-bold ps:tracking-[0.14em] ps:text-zinc-500 ps:uppercase">
                    Object types
                </p>
                <div className="ps:flex ps:flex-col ps:gap-1">
                    {objectTypes.map((objectType) => (
                        <button
                            className={
                                objectType.name === selected.name
                                    ? "ps:rounded-lg ps:border-0 ps:bg-rose-500/15 ps:px-2.5 ps:py-2 ps:text-left ps:text-xs ps:font-semibold ps:text-rose-400"
                                    : "ps:rounded-lg ps:border-0 ps:bg-transparent ps:px-2.5 ps:py-2 ps:text-left ps:text-xs ps:text-inherit ps:hover:bg-zinc-500/10"
                            }
                            key={objectType.name}
                            type="button"
                            onClick={() => {
                                setSelectedName(objectType.name);
                            }}
                        >
                            {objectType.pluralDisplayName}
                        </button>
                    ))}
                </div>
            </aside>
            <ObjectTable
                collection={collection}
                key={selected.name}
                objectType={selected}
                ontology={ontology}
            />
        </div>
    );
}

interface SchemaNode {
    objectType: ObjectTypeDef;
    x: number;
    y: number;
}

export function layoutSchema(ir: OntologyIR): {
    nodes: SchemaNode[];
    width: number;
    height: number;
} {
    const cardWidth = 230;
    const cardHeight = 176;
    const gapX = 110;
    const gapY = 90;
    const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(ir.objectTypes.length))));
    const rows = Math.max(1, Math.ceil(ir.objectTypes.length / columns));
    const nodes = ir.objectTypes.map((objectType, index) => ({
        objectType,
        x: 40 + (index % columns) * (cardWidth + gapX),
        y: 40 + Math.floor(index / columns) * (cardHeight + gapY),
    }));
    return {
        nodes,
        width: 80 + columns * cardWidth + (columns - 1) * gapX,
        height: 80 + rows * cardHeight + (rows - 1) * gapY,
    };
}

function SchemaView({ ir }: { ir: OntologyIR }) {
    const layout = layoutSchema(ir);
    const nodeByName = new Map(layout.nodes.map((node) => [node.objectType.name, node]));

    if (ir.objectTypes.length === 0) {
        return (
            <div className="ps:grid ps:h-full ps:place-items-center ps:text-sm ps:text-zinc-500">
                This ontology has no schema.
            </div>
        );
    }

    return (
        <div className="ps:h-full ps:overflow-auto ps:p-5">
            <div
                className="ps:relative ps:rounded-2xl ps:border ps:border-zinc-500/20 ps:bg-zinc-950/25 ps:in-[.ps-theme-light]:bg-white/45"
                style={{ height: layout.height, minWidth: layout.width }}
            >
                <svg
                    aria-label="Ontology relations"
                    className="ps:absolute ps:inset-0 ps:size-full ps:overflow-visible"
                    role="img"
                    viewBox={`0 0 ${layout.width} ${layout.height}`}
                >
                    <defs>
                        <marker
                            id="ps-schema-arrow"
                            markerHeight="7"
                            markerWidth="7"
                            orient="auto-start-reverse"
                            refX="6"
                            refY="3.5"
                        >
                            <path className="ps:fill-rose-400" d="M0,0 L7,3.5 L0,7 Z" />
                        </marker>
                    </defs>
                    {ir.linkTypes.map((link) => {
                        const source = nodeByName.get(link.source.objectType);
                        const target = nodeByName.get(link.target.objectType);
                        if (!source || !target) return null;
                        const sourceX = source.x + 115;
                        const sourceY = source.y + 88;
                        const targetX = target.x + 115;
                        const targetY = target.y + 88;
                        const labelX = (sourceX + targetX) / 2;
                        const labelY = (sourceY + targetY) / 2;
                        return (
                            <g key={link.id}>
                                <line
                                    className="ps:stroke-rose-400/70"
                                    markerEnd="url(#ps-schema-arrow)"
                                    strokeWidth="1.5"
                                    x1={sourceX}
                                    x2={targetX}
                                    y1={sourceY}
                                    y2={targetY}
                                />
                                <text
                                    className="ps:fill-zinc-400 ps:text-[10px]"
                                    textAnchor="middle"
                                    x={labelX}
                                    y={labelY - 6}
                                >
                                    {link.source.displayName} · {link.cardinality}
                                </text>
                            </g>
                        );
                    })}
                </svg>
                {layout.nodes.map(({ objectType, x, y }) => (
                    <article
                        className="ps:absolute ps:h-44 ps:w-[230px] ps:overflow-hidden ps:rounded-xl ps:border ps:border-zinc-500/30 ps:bg-zinc-900/95 ps:shadow-xl ps:in-[.ps-theme-light]:bg-white/95"
                        key={objectType.name}
                        style={{ left: x, top: y }}
                    >
                        <header className="ps:border-b ps:border-zinc-500/20 ps:px-3.5 ps:py-3">
                            <h3 className="ps:m-0 ps:text-sm ps:font-semibold">{objectType.displayName}</h3>
                            <p className="ps:mt-0.5 ps:mb-0 ps:font-mono ps:text-[10px] ps:text-zinc-500">
                                {objectType.name}
                            </p>
                        </header>
                        <div className="ps:max-h-28 ps:overflow-y-auto ps:px-3.5 ps:py-2">
                            {objectType.properties.map((property) => (
                                <div
                                    className="ps:flex ps:items-center ps:justify-between ps:gap-3 ps:py-1 ps:text-[11px]"
                                    key={property.name}
                                >
                                    <span className="ps:truncate">{property.displayName}</span>
                                    {property.name === objectType.primaryKey ? (
                                        <span className="ps:flex-none ps:text-[9px] ps:font-bold ps:text-rose-400">
                                            PK
                                        </span>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    </article>
                ))}
            </div>
        </div>
    );
}

export function OntologyDevtoolsPanel<Ontology extends OntologyDefinition>({
    ontology,
    theme = "dark",
}: OntologyDevtoolsPanelProps<Ontology>) {
    const { data: outboxEntries } = useLiveQuery(
        (query) => query.from({ entry: ontology.outbox.collection }),
        [ontology.outbox]
    );
    const outboxActivity = getOutboxActivity(outboxEntries);

    return (
        <Tooltip.Provider>
            <Tabs.Root
            className={`ps-devtools ps-theme-${theme} ps:flex ps:h-full ps:min-h-0 ps:w-full ps:min-w-0 ps:flex-col ps:overflow-hidden ps:font-sans ps:text-[13px] ${
                theme === "dark"
                    ? "ps:bg-zinc-950 ps:text-stone-200"
                    : "ps:bg-stone-50 ps:text-stone-800"
            }`}
            defaultValue="outbox"
            style={{ contain: "inline-size" }}
        >
            <Tabs.List
                aria-label="Ontology devtools views"
                className="ps:flex ps:flex-none ps:items-center ps:gap-1 ps:border-b ps:border-zinc-500/20 ps:px-4"
                style={{ height: 40 }}
            >
                {ontologyViews.map((view) => {
                    const Icon = view.icon;
                    return (
                        <Tabs.Tab
                            className="ps:group ps:flex ps:h-full ps:items-center ps:gap-1.5 ps:border-x-0 ps:border-t-0 ps:border-b-2 ps:border-transparent ps:bg-transparent ps:px-3 ps:text-xs ps:font-medium ps:text-zinc-500 ps:hover:text-current ps:data-[active]:border-rose-400 ps:data-[active]:font-semibold ps:data-[active]:text-rose-400"
                            key={view.id}
                            value={view.id}
                        >
                            <Icon
                                aria-hidden
                                className="ps:flex-none"
                                style={{ height: 16, width: 16 }}
                            />
                            <span>{view.label}</span>
                            {view.id === "outbox" ? (
                                <>
                                    <span
                                        className={`ps:inline-flex ps:min-w-5 ps:items-center ps:justify-center ps:rounded-full ps:px-1.5 ps:py-0.5 ps:text-center ps:text-[10px] ps:leading-none ps:transition-colors ${outboxBadgeClass(
                                            outboxActivity
                                        )}`}
                                        title={`${outboxEntries.length} outbox entries · ${outboxActivityLabel(
                                            outboxActivity
                                        )}`}
                                    >
                                        <NumberFlow
                                            className="ps:tabular-nums"
                                            isolate
                                            value={outboxEntries.length}
                                        />
                                    </span>
                                </>
                            ) : null}
                        </Tabs.Tab>
                    );
                })}
            </Tabs.List>
            <Tabs.Panel className="ps:min-h-0 ps:min-w-0 ps:flex-1 ps:overflow-hidden" value="outbox">
                <OutboxRows outbox={ontology.outbox} theme={theme} />
            </Tabs.Panel>
            <Tabs.Panel className="ps:min-h-0 ps:min-w-0 ps:flex-1 ps:overflow-hidden" value="schema">
                <SchemaView ir={ontology.ir} />
            </Tabs.Panel>
            <Tabs.Panel className="ps:min-h-0 ps:min-w-0 ps:flex-1 ps:overflow-hidden" value="objects">
                <ObjectsView ontology={ontology as LiveOntology} />
            </Tabs.Panel>
            </Tabs.Root>
        </Tooltip.Provider>
    );
}

export function createOntologyDevtoolsPlugin<Ontology extends OntologyDefinition>({
    ontology,
    id = "party-stack-ontology",
    name,
    defaultOpen,
}: OntologyDevtoolsPluginOptions<Ontology>): TanStackDevtoolsReactPlugin {
    const [createPlugin] = createReactPlugin({
        id,
        name: "Ontology",
        defaultOpen,
        Component: ({ theme }) => <OntologyDevtoolsPanel ontology={ontology} theme={theme} />,
    });

    return {
        ...createPlugin(),
        name:
            name ??
            ((_element, { theme }) => <OntologyDevtoolsPluginName theme={theme} />),
    };
}
