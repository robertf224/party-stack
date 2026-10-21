import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import { Tabs } from "@base-ui/react/tabs";
import { Tooltip } from "@base-ui/react/tooltip";
import NumberFlow from "@number-flow/react";
import { createReactPlugin } from "@tanstack/devtools-utils/react";
import { useLiveInfiniteQuery, useLiveQuery } from "@tanstack/react-db";
import {
    createColumnHelper,
    flexRender,
    useTable,
    tableFeatures,
    rowSortingFeature,
    columnOrderingFeature,
    columnSizingFeature,
    columnResizingFeature,
    columnVisibilityFeature,
    type ColumnOrderState,
    type ColumnSizingState,
    type SortingState,
    type ColumnVisibilityState,
} from "@tanstack/react-table";
import {
    RefreshCw as ArrowPathIcon,
    GripVertical as Bars2Icon,
    CalendarDays as CalendarDaysIcon,
    Boxes as BoxesIcon,
    ChartNoAxesGantt as GanttIcon,
    Check as CheckIcon,
    CircleCheck as CheckCircleIcon,
    ChevronDown as ChevronDownIcon,
    ChevronUp as ChevronUpIcon,
    ChevronsUpDown as ChevronUpDownIcon,
    Clock as ClockIcon,
    SquareCode as CodeBracketSquareIcon,
    Hash as HashtagIcon,
    Link as LinkIcon,
    List as ListBulletIcon,
    Map as MapIcon,
    MapPin as MapPinIcon,
    Paperclip as PaperClipIcon,
    CircleQuestionMark as QuestionMarkCircleIcon,
    Search as SearchIcon,
    Send as SendIcon,
    Waypoints as WaypointsIcon,
    Grid2X2 as Squares2X2Icon,
    Trash2 as TrashIcon,
    Columns3 as ViewColumnsIcon,
} from "lucide-react";
import {
    useEffect,
    useId,
    useMemo,
    useState,
    type ComponentType,
    type CSSProperties,
    type ReactNode,
} from "react";
import { DisclosureSummary } from "./DisclosureSummary.js";
import { ObjectTypeIcon } from "./OntologyIcons.js";
import { PanelBoundary, usePanelPortal } from "./PanelBoundary.js";
import { SchemaView } from "./SchemaView.js";
import { typeDisplayName } from "./typeDisplayName.js";
export { layoutSchema } from "./schemaLayout.js";
export { typeDisplayName } from "./typeDisplayName.js";
import { Queries } from "./Queries.js";
import { Tracing } from "./Tracing.js";
export { OntologyIcon } from "./OntologyIcons.js";
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

export interface OntologyDevtoolsPanelProps<
    Ontology extends OntologyDefinition = OntologyDefinition,
    MetaOntology extends OntologyDefinition = OntologyDefinition,
> {
    ontology: LiveOntology<Ontology>;
    metaOntology?: LiveOntology<MetaOntology>;
    theme?: "light" | "dark";
}

export interface OntologyDevtoolsPluginOptions<
    Ontology extends OntologyDefinition = OntologyDefinition,
    MetaOntology extends OntologyDefinition = OntologyDefinition,
> {
    ontology: LiveOntology<Ontology>;
    id?: string;
    metaOntology?: LiveOntology<MetaOntology>;
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
            style={{
                alignItems: "center",
                background: dark
                    ? "linear-gradient(145deg, #2d2d31, #171719)"
                    : "linear-gradient(145deg, #fff, #f5f5f4)",
                border: dark ? "1px solid rgba(255,255,255,.16)" : "1px solid rgba(23,23,23,.14)",
                borderRadius: "999px",
                boxSizing: "border-box",
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

export function ontologyDevtoolsTrigger(_element: HTMLElement, { theme }: OntologyDevtoolsChromeProps) {
    return <OntologyDevtoolsTrigger theme={theme} />;
}

function OutboxPanel({ children, theme }: { children: ReactNode; theme: "light" | "dark" }) {
    return (
        <div className={`ps-outbox-root ps-theme-${theme}`}>
            <div className="ps-outbox">{children}</div>
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
                <span
                    className="ps-outbox-attempts"
                    title={
                        entry.attemptStage === "forwarding"
                            ? `${entry.attempts} forwarding attempts; upstream execution has not been observed yet.`
                            : "Attempts to execute at this replica's upstream."
                    }
                >
                    {entry.attemptStage === "forwarding" ? (
                        "Forwarding"
                    ) : (
                        <>
                            Attempts: <strong>{entry.attempts}</strong>
                        </>
                    )}
                </span>
                <span aria-hidden="true" className="ps-outbox-meta-divider" />
                <span className="ps-outbox-time" title={new Date(entry.createdAt).toLocaleString()}>
                    Queued {formatRelativeTime(entry.createdAt, now)}
                </span>
                {!entry.retryable ? <span className="ps-outbox-permanent">Won&apos;t retry</span> : null}
            </div>
            {entry.lastError ? <div className="ps-outbox-error">{entry.lastError.message}</div> : null}
            <details className="ps-outbox-details">
                <DisclosureSummary>Parameters</DisclosureSummary>
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

function OutboxRows({ outbox, theme }: { outbox: OntologyOutbox; theme: "light" | "dark" }) {
    const now = useRelativeTimeNow();
    const { data } = useLiveQuery({
        query: (query) =>
            query.from({ entry: outbox.collection }).orderBy(({ entry }) => entry.sequence, "asc"),
    });

    return (
        <OutboxPanel theme={theme}>
            {data.length === 0 ? (
                <div className="ps-outbox-empty">
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
                    {data.map((entry, index) => (
                        <div className="ps-outbox-step" key={entry.id}>
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

type OntologyDevtoolsView = "objects" | "schema" | "outbox" | "meta" | "tracing" | "queries";
type OutboxActivity = "idle" | "draining" | "paused";

export function getOutboxActivity(entries: OntologyOutboxEntry[]): OutboxActivity {
    if (entries.length === 0) return "idle";
    const head = entries.reduce((first, entry) => (entry.sequence < first.sequence ? entry : first));
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
            return "ps:bg-[var(--ps-raised)] ps:text-[var(--ps-muted)]";
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
    { id: "objects", label: "Objects", icon: BoxesIcon },
    { id: "outbox", label: "Outbox", icon: SendIcon },
    { id: "queries", label: "Queries", icon: SearchIcon },
    { id: "tracing", label: "Tracing", icon: GanttIcon },
    { id: "schema", label: "Schema", icon: WaypointsIcon },
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
        case "encrypted":
            return CodeBracketSquareIcon;
        case "struct":
        case "union":
        case "result":
            return MapIcon;
        case "unknown":
            return QuestionMarkCircleIcon;
    }
}

function DevtoolsTooltip({ children, label }: { children: ReactNode; label: ReactNode }) {
    const portal = usePanelPortal();
    return (
        <Tooltip.Root>
            <Tooltip.Trigger render={<span className="ps:inline-flex ps:items-center" />}>
                {children}
            </Tooltip.Trigger>
            <Tooltip.Portal container={portal}>
                <Tooltip.Positioner className="ps:z-[100001]" sideOffset={6}>
                    <Tooltip.Popup className="ps:max-w-64 ps:rounded-md ps:border ps:border-[var(--ps-border)] ps:bg-[var(--ps-raised)] ps:px-2.5 ps:py-1.5 ps:text-[11px] ps:text-[var(--ps-text)] ps:shadow-xl">
                        {label}
                    </Tooltip.Popup>
                </Tooltip.Positioner>
            </Tooltip.Portal>
        </Tooltip.Root>
    );
}

function TypeIndicator({ type }: { type: TypeDef }) {
    const Icon = typeIcon(type);
    return (
        <DevtoolsTooltip label={typeDisplayName(type)}>
            {/* oxlint-disable-next-line react/static-components -- typeIcon selects an imported static icon; it does not create a component. */}
            <Icon aria-hidden className="ps:size-3.5 ps:text-[var(--ps-muted)]" />
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

/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Inline SVG is an image, not an HTML img. */
function GeopointPreview({ value }: { value: v.geopoint }) {
    const cx = value.lon + 180;
    const cy = 90 - value.lat;
    const label = `${value.lat.toFixed(4)}, ${value.lon.toFixed(4)}`;
    return (
        <DevtoolsTooltip
            label={
                <svg
                    aria-label={`Map preview for ${label}`}
                    className="ps:block ps:rounded ps:border ps:border-[var(--ps-border)]"
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

/* oxlint-enable jsx-a11y/prefer-tag-over-role */
export function timestampPreview(value: unknown): { display: string; exact: string } | undefined {
    if (value === undefined || value === null) return undefined;
    const exact = formatObjectValue(value);
    let epochMilliseconds: number | undefined;
    if (value instanceof Date) {
        epochMilliseconds = value.getTime();
    } else if (
        typeof value === "object" &&
        "epochMilliseconds" in value &&
        (typeof value.epochMilliseconds === "number" || typeof value.epochMilliseconds === "bigint")
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

function AttachmentPreview({ attachment, ontology }: { attachment: v.attachment; ontology: LiveOntology }) {
    const portal = usePanelPortal();
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
                    <PaperClipIcon
                        aria-hidden
                        className="ps:size-3.5 ps:flex-none ps:text-[var(--ps-muted)]"
                    />
                    <span className="ps:truncate">{label}</span>
                </span>
            </DevtoolsTooltip>
        );
    }

    return (
        <Dialog.Root>
            <Dialog.Trigger
                aria-label={`Open ${label}`}
                className="ps:block ps:overflow-hidden ps:rounded-md ps:border ps:border-[var(--ps-border)] ps:bg-transparent ps:p-0 ps:hover:border-[var(--ps-accent)]"
            >
                <img alt={label} className="ps:block ps:size-7 ps:object-cover" src={preview.src} />
            </Dialog.Trigger>
            <Dialog.Portal container={portal}>
                <Dialog.Backdrop className="ps:fixed ps:inset-0 ps:z-[100002] ps:bg-black/75 ps:backdrop-blur-sm" />
                <Dialog.Viewport className="ps:fixed ps:inset-0 ps:z-[100003] ps:grid ps:place-items-center ps:p-8">
                    <Dialog.Popup className="ps:relative ps:max-h-full ps:max-w-4xl ps:rounded-xl ps:border ps:border-[var(--ps-border)] ps:bg-[var(--ps-bg)] ps:p-3 ps:shadow-2xl">
                        <Dialog.Title className="ps:sr-only">{label}</Dialog.Title>
                        <img
                            alt={label}
                            className="ps:max-h-[80vh] ps:max-w-[80vw] ps:rounded-lg ps:object-contain"
                            src={preview.src}
                        />
                        <Dialog.Close className="ps:absolute ps:top-4 ps:right-4 ps:rounded-md ps:border ps:border-[var(--ps-border-strong)] ps:bg-[var(--ps-surface)] ps:px-2.5 ps:py-1.5 ps:text-xs ps:text-[var(--ps-text)]">
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
        return <PropertyValuePreview ir={ir} ontology={ontology} type={resolved.value.type} value={value} />;
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
                        <AttachmentPreview attachment={attachment} key={attachment.id} ontology={ontology} />
                    ))}
                    {attachments.length > 3 ? (
                        <span className="ps:text-[var(--ps-muted)]">+{attachments.length - 3}</span>
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

export function moveColumn(columnOrder: string[], sourceId: string, targetId: string): string[] {
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

const objectTableFeatures = tableFeatures({
    rowSortingFeature,
    columnOrderingFeature,
    columnSizingFeature,
    columnResizingFeature,
    columnVisibilityFeature,
});
const objectColumnHelper = createColumnHelper<typeof objectTableFeatures, Record<string, unknown>>();

function ObjectTable({
    collection,
    objectType,
    ontology,
    pageSize,
}: {
    collection: LiveOntology["objects"][string];
    objectType: ObjectTypeDef;
    ontology: LiveOntology;
    pageSize: number;
}) {
    const portal = usePanelPortal();
    const [sorting, setSorting] = useState<SortingState>([]);
    const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
    const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>({});
    const [columnOrder, setColumnOrder] = useState<ColumnOrderState>(() =>
        objectType.properties.map((property) => property.name)
    );
    const [draggedColumnId, setDraggedColumnId] = useState<string>();
    const [dragOverColumnId, setDragOverColumnId] = useState<string>();
    const selectedSort = sorting[0];
    const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useLiveInfiniteQuery(
        (query) => {
            const from = query.from({ row: collection });
            const primaryKey = objectType.primaryKey;
            if (selectedSort && selectedSort.id !== primaryKey) {
                return from
                    .orderBy(
                        ({ row }) => (row as Record<string, unknown>)[selectedSort.id] as string | number,
                        selectedSort.desc ? "desc" : "asc"
                    )
                    .orderBy(
                        ({ row }) => (row as Record<string, unknown>)[primaryKey] as string | number,
                        "asc"
                    )
                    .select(({ row }) => row as Record<string, unknown>);
            }
            return from
                .orderBy(
                    ({ row }) => (row as Record<string, unknown>)[primaryKey] as string | number,
                    selectedSort?.desc ? "desc" : "asc"
                )
                .select(({ row }) => row as Record<string, unknown>);
        },
        { pageSize },
        [collection.id, objectType.primaryKey, pageSize, selectedSort?.id, selectedSort?.desc]
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
                            <TypeIndicator type={property.type} />
                            <span>{property.displayName}</span>
                            {property.name === objectType.primaryKey ? (
                                <span className="ps:ml-1.5 ps:text-[9px] ps:font-bold ps:tracking-wide ps:text-[var(--ps-accent)]">
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
    const table = useTable({
        features: objectTableFeatures,
        columnResizeMode: "onEnd",
        columns,
        data: rows,
        enableColumnResizing: true,
        getRowId: (row, index) => `${formatObjectValue(row[objectType.primaryKey])}-${index}`,
        manualSorting: true,
        onColumnOrderChange: setColumnOrder,
        onColumnSizingChange: setColumnSizing,
        onColumnVisibilityChange: setColumnVisibility,
        onSortingChange: setSorting,
        state: { columnOrder, columnSizing, columnVisibility, sorting },
    });
    const resizingColumnId = table.state.columnResizing.isResizingColumn;
    const resizingColumn =
        typeof resizingColumnId === "string" ? table.getColumn(resizingColumnId) : undefined;
    const allColumns = table.getAllLeafColumns();

    return (
        <div className="ps:flex ps:min-h-0 ps:min-w-0 ps:flex-1 ps:flex-col ps:overflow-hidden">
            <div className="ps:bg-[var(--ps-surface)] ps:flex ps:flex-none ps:items-center ps:border-b ps:border-[var(--ps-border)] ps:px-4 ps:py-2">
                <h2 className="ps:m-0 ps:flex ps:items-center ps:gap-2 ps:text-lg ps:font-semibold">
                    <ObjectTypeIcon
                        className="ps:size-5 ps:flex-none ps:text-[var(--ps-accent)]"
                        objectType={objectType}
                    />
                    {objectType.pluralDisplayName}
                </h2>
                <div className="ps:ml-auto ps:flex ps:items-center ps:gap-1.5">
                    <button
                        className="ps:inline-flex ps:items-center ps:gap-1.5 ps:rounded-md ps:border-0 ps:bg-transparent ps:px-2 ps:py-1.5 ps:text-xs ps:text-[var(--ps-muted)] ps:hover:bg-[var(--ps-hover)] ps:hover:text-current ps:disabled:opacity-40"
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
                        <Menu.Trigger className="ps:inline-flex ps:items-center ps:gap-1.5 ps:rounded-md ps:border ps:border-[var(--ps-border)] ps:bg-[var(--ps-hover)] ps:px-2.5 ps:py-1.5 ps:text-xs ps:text-inherit ps:hover:border-[var(--ps-border-strong)]">
                            <ViewColumnsIcon aria-hidden className="ps:size-3.5" />
                            Columns
                        </Menu.Trigger>
                        <Menu.Portal container={portal}>
                            <Menu.Positioner align="end" className="ps:z-[100001]" sideOffset={6}>
                                <Menu.Popup className="ps:min-w-48 ps:rounded-lg ps:border ps:border-[var(--ps-border)] ps:bg-[var(--ps-raised)] ps:p-1.5 ps:text-xs ps:text-[var(--ps-text)] ps:shadow-2xl">
                                    <Menu.Group>
                                        <Menu.GroupLabel className="ps:px-2 ps:py-1.5 ps:text-[10px] ps:font-bold ps:tracking-wider ps:text-[var(--ps-muted)] ps:uppercase">
                                            Columns
                                        </Menu.GroupLabel>
                                        {allColumns.map((column, columnIndex) => (
                                            <Menu.CheckboxItem
                                                aria-label={
                                                    objectType.properties.find(
                                                        (property) => property.name === column.id
                                                    )?.displayName ?? column.id
                                                }
                                                checked={column.getIsVisible()}
                                                className={
                                                    dragOverColumnId === column.id &&
                                                    draggedColumnId !== column.id
                                                        ? "ps:flex ps:cursor-default ps:items-center ps:gap-2 ps:rounded-md ps:bg-[var(--ps-selected)] ps:px-2 ps:py-1.5 ps:outline-none"
                                                        : "ps:flex ps:cursor-default ps:items-center ps:gap-2 ps:rounded-md ps:px-2 ps:py-1.5 ps:outline-none ps:data-[highlighted]:bg-[var(--ps-hover)]"
                                                }
                                                draggable
                                                key={column.id}
                                                label={
                                                    objectType.properties.find(
                                                        (property) => property.name === column.id
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
                                                    event.dataTransfer.setData("text/plain", column.id);
                                                    setDraggedColumnId(column.id);
                                                }}
                                                onDrop={(event) => {
                                                    event.preventDefault();
                                                    if (draggedColumnId && draggedColumnId !== column.id) {
                                                        setColumnOrder((current) =>
                                                            moveColumn(current, draggedColumnId, column.id)
                                                        );
                                                    }
                                                    setDraggedColumnId(undefined);
                                                    setDragOverColumnId(undefined);
                                                }}
                                                onKeyDown={(event) => {
                                                    if (
                                                        !event.altKey ||
                                                        (event.key !== "ArrowUp" && event.key !== "ArrowDown")
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
                                                            moveColumn(current, column.id, target.id)
                                                        );
                                                    }
                                                }}
                                            >
                                                <span
                                                    aria-hidden="true"
                                                    className="ps:cursor-grab ps:text-[var(--ps-muted)] ps:active:cursor-grabbing"
                                                    title="Drag to reorder"
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                    }}
                                                >
                                                    <Bars2Icon aria-hidden className="ps:size-3.5" />
                                                </span>
                                                <span className="ps:grid ps:size-4 ps:place-items-center ps:rounded ps:border ps:border-[var(--ps-border-strong)]">
                                                    {column.getIsVisible() ? (
                                                        <CheckIcon
                                                            aria-hidden
                                                            className="ps:size-3 ps:text-[var(--ps-accent)]"
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
                                        <p className="ps:m-0 ps:px-2 ps:pt-2 ps:pb-1 ps:text-[10px] ps:text-[var(--ps-muted)]">
                                            Drag to reorder · Alt+↑/↓ with keyboard
                                        </p>
                                    </Menu.Group>
                                </Menu.Popup>
                            </Menu.Positioner>
                        </Menu.Portal>
                    </Menu.Root>
                </div>
            </div>
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
                                                className="ps:relative ps:border-b ps:border-[var(--ps-border)] ps:bg-[var(--ps-surface)] ps:px-4 ps:py-3 ps:font-semibold ps:whitespace-nowrap ps:backdrop-blur"
                                                key={header.id}
                                            >
                                                {header.isPlaceholder ? null : (
                                                    <button
                                                        className="ps:flex ps:w-full ps:items-center ps:gap-2 ps:border-0 ps:bg-transparent ps:p-0 ps:text-left ps:text-inherit ps:font-inherit ps:hover:text-[var(--ps-accent)]"
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
                                                                className="ps:size-3.5 ps:flex-none ps:text-[var(--ps-accent)]"
                                                            />
                                                        ) : direction === "desc" ? (
                                                            <ChevronDownIcon
                                                                aria-hidden
                                                                className="ps:size-3.5 ps:flex-none ps:text-[var(--ps-accent)]"
                                                            />
                                                        ) : (
                                                            <ChevronUpDownIcon
                                                                aria-hidden
                                                                className="ps:size-3.5 ps:flex-none ps:text-[var(--ps-muted)]"
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
                                                {
                                                    header.column.getCanResize() ? (
                                                        // oxlint-disable jsx-a11y/prefer-tag-over-role -- This focusable separator adjusts column width; an hr cannot replace it.
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
                                                                            header.column.getSize() + delta
                                                                        )
                                                                    ),
                                                                }));
                                                            }}
                                                            onMouseDown={header.getResizeHandler()}
                                                            onTouchStart={header.getResizeHandler()}
                                                        />
                                                    ) : null /* oxlint-enable jsx-a11y/prefer-tag-over-role */
                                                }
                                            </th>
                                        );
                                    })}
                                </tr>
                            ))}
                        </thead>
                        <tbody>
                            {rows.length === 0 && (
                                <tr>
                                    <td
                                        colSpan={table.getVisibleLeafColumns().length}
                                        className="ps:h-40 ps:px-4 ps:pt-6 ps:align-top ps:text-[var(--ps-muted)]"
                                    >
                                        <output>
                                            {isLoading ? "Loading objects…" : "No objects loaded"}
                                        </output>
                                    </td>
                                </tr>
                            )}
                            {table.getRowModel().rows.map((row) => (
                                <tr className="ps-object-data-row ps:hover:bg-[var(--ps-hover)]" key={row.id}>
                                    {row.getVisibleCells().map((cell) => (
                                        <td
                                            className="ps-object-data-cell ps:max-w-80 ps:border-b ps:border-[var(--ps-border)] ps:px-4 ps:text-[11px] ps:whitespace-nowrap"
                                            key={cell.id}
                                        >
                                            <div className="ps-object-cell-content">
                                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                            </div>
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {hasNextPage ? (
                        <div className="ps:sticky ps:left-0 ps:flex ps:w-full ps:justify-center ps:border-t ps:border-[var(--ps-border)] ps:bg-[var(--ps-surface)] ps:p-3">
                            <button
                                className="ps:rounded-md ps:border ps:border-[var(--ps-border-strong)] ps:bg-[var(--ps-raised)] ps:px-3 ps:py-1.5 ps:text-xs ps:text-[var(--ps-text)] ps:hover:border-[var(--ps-accent)] ps:hover:text-[var(--ps-accent)] ps:disabled:opacity-50"
                                disabled={isFetchingNextPage}
                                type="button"
                                onClick={() => void fetchNextPage()}
                            >
                                {isFetchingNextPage ? "Loading…" : `Load ${pageSize} more`}
                            </button>
                        </div>
                    ) : null}
                    {resizingColumn ? (
                        <div
                            className="ps:pointer-events-none ps:absolute ps:inset-y-0 ps:z-50 ps:w-0.5 ps:bg-rose-400 ps:shadow-[0_0_0_1px_rgba(251,113,133,0.18)] ps:will-change-transform"
                            style={{
                                left: resizingColumn.getStart() + resizingColumn.getSize(),
                                transform: `translateX(${table.state.columnResizing.deltaOffset ?? 0}px)`,
                            }}
                        />
                    ) : null}
                </div>
            </div>
        </div>
    );
}

function ObjectsView({ ontology, pageSize = 50 }: { ontology: LiveOntology; pageSize?: number }) {
    const objectTypes = ontology.ir.objectTypes;
    const [selectedName, setSelectedName] = useState(() => objectTypes[0]?.name);
    const selected = objectTypes.find((objectType) => objectType.name === selectedName) ?? objectTypes[0];
    const collection = selected ? ontology.persistedObjects?.[selected.name] : undefined;

    if (!selected || !collection) {
        return (
            <div className="ps:grid ps:h-full ps:place-items-center ps:text-sm ps:text-[var(--ps-muted)]">
                Persisted object inspection is unavailable for this ontology runtime.
            </div>
        );
    }

    return (
        <div className="ps:flex ps:h-full ps:min-h-0 ps:w-full ps:min-w-0 ps:overflow-hidden">
            <aside className="ps:w-44 ps:flex-none ps:overflow-y-auto ps:border-r ps:border-[var(--ps-border)] ps:p-3">
                <p className="ps:mt-0 ps:mb-2 ps:px-2 ps:text-[10px] ps:font-bold ps:tracking-[0.14em] ps:text-[var(--ps-muted)] ps:uppercase">
                    Object types
                </p>
                <div className="ps:flex ps:flex-col ps:gap-1">
                    {objectTypes.map((objectType) => (
                        <button
                            className={
                                objectType.name === selected.name
                                    ? "ps:flex ps:items-center ps:gap-2 ps:rounded-lg ps:border-0 ps:bg-[var(--ps-selected)] ps:px-2.5 ps:py-2 ps:text-left ps:text-xs ps:font-semibold ps:text-[var(--ps-accent)]"
                                    : "ps:flex ps:items-center ps:gap-2 ps:rounded-lg ps:border-0 ps:bg-transparent ps:px-2.5 ps:py-2 ps:text-left ps:text-xs ps:text-inherit ps:hover:bg-[var(--ps-hover)]"
                            }
                            key={objectType.name}
                            type="button"
                            onClick={() => {
                                setSelectedName(objectType.name);
                            }}
                        >
                            <ObjectTypeIcon className="ps:size-4 ps:flex-none" objectType={objectType} />
                            <span className="ps:truncate">{objectType.pluralDisplayName}</span>
                        </button>
                    ))}
                </div>
            </aside>
            <ObjectTable
                collection={collection}
                key={selected.name}
                objectType={selected}
                ontology={ontology}
                pageSize={pageSize}
            />
        </div>
    );
}

export function OntologyDevtoolsPanel<
    Ontology extends OntologyDefinition,
    MetaOntology extends OntologyDefinition = OntologyDefinition,
>(props: OntologyDevtoolsPanelProps<Ontology, MetaOntology>) {
    return (
        <PanelBoundary theme={props.theme ?? "dark"}>
            <OntologyDevtoolsContent {...props} />
        </PanelBoundary>
    );
}

function OntologyDevtoolsContent<
    Ontology extends OntologyDefinition,
    MetaOntology extends OntologyDefinition = OntologyDefinition,
>({ metaOntology, ontology, theme = "dark" }: OntologyDevtoolsPanelProps<Ontology, MetaOntology>) {
    const { data: outboxEntries } = useLiveQuery({
        query: (query) => query.from({ entry: ontology.outbox.collection }),
    });
    const outboxActivity = getOutboxActivity(outboxEntries);

    return (
        <Tooltip.Provider>
            <Tabs.Root
                data-ps-devtools
                className={`ps-devtools ps-theme-${theme} ps:flex ps:h-full ps:min-h-0 ps:w-full ps:min-w-0 ps:flex-col ps:overflow-hidden ps:font-sans ps:text-[13px]`}
                defaultValue="objects"
                style={{ contain: "inline-size" }}
            >
                <Tabs.List
                    aria-label="Ontology devtools views"
                    className="ps:bg-[var(--ps-surface)] ps:flex ps:flex-none ps:items-center ps:gap-1 ps:border-b ps:border-[var(--ps-border)] ps:px-4"
                    style={{ height: 40 }}
                >
                    {[
                        ...ontologyViews,
                        ...(metaOntology
                            ? [
                                  {
                                      id: "meta" as const,
                                      label: "Meta",
                                      icon: CodeBracketSquareIcon,
                                  },
                              ]
                            : []),
                    ].map((view) => {
                        const Icon = view.icon;
                        return (
                            <Tabs.Tab
                                className="ps:group ps:flex ps:h-full ps:items-center ps:gap-1.5 ps:border-x-0 ps:border-t-0 ps:border-b-2 ps:border-transparent ps:bg-transparent ps:px-3 ps:text-xs ps:font-medium ps:text-[var(--ps-muted)] ps:hover:text-current ps:data-[active]:border-[var(--ps-accent)] ps:data-[active]:font-semibold ps:data-[active]:text-[var(--ps-accent)]"
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
                    <SchemaView ir={ontology.ir} theme={theme} />
                </Tabs.Panel>
                <Tabs.Panel className="ps:min-h-0 ps:min-w-0 ps:flex-1 ps:overflow-hidden" value="objects">
                    <ObjectsView ontology={ontology} />
                </Tabs.Panel>
                <Tabs.Panel className="ps:min-h-0 ps:min-w-0 ps:flex-1 ps:overflow-hidden" value="tracing">
                    <Tracing ontology={ontology} />
                </Tabs.Panel>
                <Tabs.Panel className="ps:min-h-0 ps:min-w-0 ps:flex-1 ps:overflow-hidden" value="queries">
                    <Queries ontology={ontology} />
                </Tabs.Panel>
                {metaOntology ? (
                    <Tabs.Panel className="ps:min-h-0 ps:min-w-0 ps:flex-1 ps:overflow-hidden" value="meta">
                        <ObjectsView ontology={metaOntology} pageSize={25} />
                    </Tabs.Panel>
                ) : null}
            </Tabs.Root>
        </Tooltip.Provider>
    );
}

export function createOntologyDevtoolsPlugin<
    Ontology extends OntologyDefinition,
    MetaOntology extends OntologyDefinition = OntologyDefinition,
>({
    ontology,
    id = "party-stack-ontology",
    metaOntology,
    name,
    defaultOpen,
}: OntologyDevtoolsPluginOptions<Ontology, MetaOntology>): TanStackDevtoolsReactPlugin {
    const [createPlugin] = createReactPlugin({
        id,
        name: "Ontology",
        defaultOpen,
        Component: ({ theme }) => (
            <OntologyDevtoolsPanel metaOntology={metaOntology} ontology={ontology} theme={theme} />
        ),
    });

    return {
        ...createPlugin(),
        name: name ?? ((_element, { theme }) => <OntologyDevtoolsPluginName theme={theme} />),
    };
}
