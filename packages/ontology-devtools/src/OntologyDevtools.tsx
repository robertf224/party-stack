import { ArrowPathIcon, CheckIcon, InboxStackIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useLiveQuery } from "@tanstack/react-db";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type {
    LiveOntology,
    OntologyDefinition,
    OntologyOutbox,
    OntologyOutboxEntry,
} from "@party-stack/ontology";

export interface OntologyDevtoolsProps<Ontology extends OntologyDefinition = OntologyDefinition> {
    ontology: LiveOntology<Ontology>;
}

const styles = `
.ps-outbox-root {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}
.ps-outbox {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden auto;
  overscroll-behavior: contain;
  padding: 20px 22px;
  color: #e7e5e4;
  background:
    radial-gradient(circle at 8% 0%, rgba(232, 59, 50, .12), transparent 30%),
    linear-gradient(145deg, #171717 0%, #111113 100%);
  font: 13px/1.45 Inter, ui-sans-serif, system-ui, sans-serif;
}
.ps-outbox * { box-sizing: border-box; }
.ps-outbox-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}
.ps-outbox-heading {
  display: flex;
  align-items: center;
  gap: 11px;
}
.ps-outbox-mark {
  width: 30px;
  height: 30px;
  padding: 5px;
  border: 1px solid rgba(255, 255, 255, .1);
  border-radius: 10px;
  background: rgba(255, 255, 255, .06);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .24);
  color: #fb7185;
}
.ps-outbox-mark svg { display: block; width: 100%; height: 100%; }
.ps-outbox-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ps-outbox-title {
  margin: 0;
  color: #fafaf9;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -.015em;
}
.ps-outbox-subtitle { margin: 2px 0 0; color: #a8a29e; font-size: 12px; }
.ps-outbox-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 25px;
  padding: 2px 7px;
  border: 1px solid #3f3f46;
  border-radius: 999px;
  color: #d6d3d1;
  background: rgba(39, 39, 42, .75);
  text-align: center;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.ps-outbox-track {
  display: flex;
  align-items: flex-start;
  width: 100%;
  padding: 4px 2px 16px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: thin;
  scrollbar-color: #52525b transparent;
  scroll-snap-type: x proximity;
}
.ps-outbox-step {
  display: flex;
  flex: none;
  align-items: flex-start;
}
.ps-outbox-node {
  flex: 0 0 clamp(250px, 31vw, 330px);
  min-width: 0;
  scroll-snap-align: start;
}
.ps-outbox-connector {
  position: relative;
  flex: 0 0 52px;
  align-self: flex-start;
  height: 2px;
  margin: 30px 8px 0;
  border-radius: 999px;
  background: linear-gradient(90deg, #3f3f46, #52525b);
}
.ps-outbox-connector::before {
  position: absolute;
  z-index: 1;
  right: 0;
  top: -3px;
  width: 7px;
  height: 7px;
  content: "";
  border-top: 2px solid #71717a;
  border-right: 2px solid #71717a;
  transform: rotate(45deg);
}
.ps-outbox-card {
  position: relative;
  min-height: 190px;
  padding: 15px;
  overflow: hidden;
  border: 1px solid #36363b;
  border-radius: 14px;
  background: linear-gradient(155deg, rgba(45, 45, 50, .96), rgba(31, 31, 35, .96));
  box-shadow: 0 14px 36px rgba(0, 0, 0, .2);
}
.ps-outbox-card::before {
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  content: "";
  background: #38bdf8;
}
.ps-card-executing::before {
  background: #f59e0b;
}
.ps-card-failed::before { background: #ef4444; }
.ps-outbox-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.ps-outbox-name {
  min-width: 0;
  overflow: hidden;
  color: #fafaf9;
  font-size: 14px;
  font-weight: 680;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ps-outbox-status {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border: 1px solid currentColor;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .03em;
}
.ps-status-dot { width: 5px; height: 5px; border-radius: 999px; background: currentColor; }
.ps-status-queued { color: #7dd3fc; background: rgba(12, 74, 110, .45); }
.ps-status-executing { color: #fcd34d; background: rgba(120, 53, 15, .42); }
.ps-status-failed { color: #fca5a5; background: rgba(127, 29, 29, .42); }
.ps-outbox-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 13px;
  margin-top: 10px;
  color: #a8a29e;
  font-size: 11px;
}
.ps-outbox-meta strong { color: #d6d3d1; font-weight: 600; }
.ps-outbox-meta-divider {
  align-self: center;
  width: 3px;
  height: 3px;
  border-radius: 999px;
  background: currentColor;
  opacity: .65;
}
.ps-outbox-permanent { color: #fca5a5; }
.ps-outbox-time { cursor: help; font-variant-numeric: tabular-nums; }
.ps-outbox-error {
  margin-top: 11px;
  padding: 8px 10px;
  border: 1px solid rgba(239, 68, 68, .35);
  border-radius: 8px;
  color: #fecaca;
  background: rgba(69, 10, 10, .55);
  font-size: 11px;
  white-space: pre-wrap;
}
.ps-outbox-details { margin-top: 11px; color: #a8a29e; font-size: 11px; }
.ps-outbox-details summary { cursor: pointer; user-select: none; transition: color 120ms ease; }
.ps-outbox-details summary:hover { color: #e7e5e4; }
.ps-outbox-details pre {
  max-height: 150px;
  margin: 8px 0 0;
  padding: 10px;
  overflow: auto;
  border: 1px solid #303036;
  border-radius: 8px;
  color: #d4d4d8;
  background: rgba(9, 9, 11, .7);
  font: 11px/1.5 ui-monospace, SFMono-Regular, monospace;
}
.ps-outbox-actions { display: flex; gap: 7px; margin-top: 13px; }
.ps-button {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border: 1px solid transparent;
  border-radius: 7px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, opacity 120ms ease;
}
.ps-button svg { width: 13px; height: 13px; }
.ps-button:disabled { cursor: not-allowed; opacity: .4; }
.ps-button-primary { color: #e0f2fe; border-color: #075985; background: rgba(7, 89, 133, .7); }
.ps-button-primary:not(:disabled):hover { background: #0369a1; }
.ps-button-danger { color: #fca5a5; border-color: #7f1d1d; background: rgba(69, 10, 10, .16); }
.ps-button-danger:not(:disabled):hover { background: rgba(127, 29, 29, .7); }
.ps-outbox-action-error { margin-top: 8px; color: #fca5a5; font-size: 12px; }
.ps-outbox-empty {
  display: grid;
  place-items: center;
  min-height: 150px;
  padding: 28px 16px;
  border: 1px dashed #3f3f46;
  border-radius: 14px;
  color: #a8a29e;
  background: rgba(39, 39, 42, .3);
  text-align: center;
}
.ps-outbox-empty-mark {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  margin: 0 auto 9px;
  border: 1px solid #3f3f46;
  border-radius: 999px;
  color: #86efac;
  background: #1c2920;
}
.ps-outbox-empty-mark svg { width: 17px; height: 17px; }
.ps-outbox-empty strong { display: block; margin-bottom: 2px; color: #e7e5e4; }
html[data-ps-outbox-transition]::view-transition-old(root),
html[data-ps-outbox-transition]::view-transition-new(root) {
  animation: none;
}
html[data-ps-outbox-transition]::view-transition-group(*) {
  animation-duration: 240ms;
  animation-timing-function: cubic-bezier(.22, 1, .36, 1);
}
.ps-theme-light .ps-outbox {
  color: #292524;
  background:
    radial-gradient(circle at 8% 0%, rgba(232, 59, 50, .1), transparent 30%),
    linear-gradient(145deg, #fafaf9 0%, #f5f5f4 100%);
}
.ps-theme-light .ps-outbox-mark {
  color: #dc2626;
  border-color: #e7e5e4;
  background: rgba(255, 255, 255, .82);
  box-shadow: 0 8px 22px rgba(41, 37, 36, .1);
}
.ps-theme-light .ps-outbox-title,
.ps-theme-light .ps-outbox-name,
.ps-theme-light .ps-outbox-empty strong {
  color: #1c1917;
}
.ps-theme-light .ps-outbox-subtitle,
.ps-theme-light .ps-outbox-meta,
.ps-theme-light .ps-outbox-details {
  color: #78716c;
}
.ps-theme-light .ps-outbox-meta strong { color: #44403c; }
.ps-theme-light .ps-outbox-count {
  color: #57534e;
  border-color: #d6d3d1;
  background: rgba(255, 255, 255, .8);
}
.ps-theme-light .ps-outbox-card {
  border-color: #d6d3d1;
  background: linear-gradient(155deg, rgba(255, 255, 255, .98), rgba(245, 245, 244, .98));
  box-shadow: 0 14px 34px rgba(41, 37, 36, .1);
}
.ps-theme-light .ps-outbox-connector { background: #d6d3d1; }
.ps-theme-light .ps-outbox-details summary:hover { color: #292524; }
.ps-theme-light .ps-outbox-details pre {
  color: #44403c;
  border-color: #e7e5e4;
  background: rgba(255, 255, 255, .86);
}
.ps-theme-light .ps-outbox-empty {
  color: #78716c;
  border-color: #d6d3d1;
  background: rgba(255, 255, 255, .55);
}
.ps-theme-light .ps-outbox-empty-mark {
  color: #15803d;
  border-color: #bbf7d0;
  background: #f0fdf4;
}
.ps-theme-light .ps-button-primary {
  color: #075985;
  border-color: #7dd3fc;
  background: #e0f2fe;
}
.ps-theme-light .ps-button-primary:not(:disabled):hover { background: #bae6fd; }
.ps-theme-light .ps-button-danger {
  color: #b91c1c;
  border-color: #fecaca;
  background: #fff7f7;
}
.ps-theme-light .ps-button-danger:not(:disabled):hover { background: #fee2e2; }
`;

function PartyStackLogo({ theme }: { theme: "light" | "dark" }) {
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

function PartyStackPluginName({ theme }: { theme: "light" | "dark" }) {
    return (
        <div style={{ height: 30, width: 120 }}>
            <PartyStackLogo theme={theme} />
        </div>
    );
}

function OutboxPanel({ children, theme }: { children: ReactNode; theme: "light" | "dark" }) {
    return (
        <div className={`ps-outbox-root ps-theme-${theme}`}>
            <div className="ps-outbox">
                <style>{styles}</style>
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
            <header className="ps-outbox-header">
                <div className="ps-outbox-heading">
                    <div className="ps-outbox-mark">
                        <InboxStackIcon aria-hidden="true" />
                    </div>
                    <div>
                        <div className="ps-outbox-title-row">
                            <h2 className="ps-outbox-title">Outbox</h2>
                            <span className="ps-outbox-count">{visibleData.length}</span>
                        </div>
                        <p className="ps-outbox-subtitle">Actions waiting to sync</p>
                    </div>
                </div>
            </header>
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

function OntologyPanel({ ontology, theme }: { ontology: LiveOntology; theme: "light" | "dark" }) {
    return <OutboxRows outbox={ontology.outbox} theme={theme} />;
}

function OntologyTrigger({ theme }: { theme: "light" | "dark" }) {
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

export function OntologyDevtools<Ontology extends OntologyDefinition>({
    ontology,
}: OntologyDevtoolsProps<Ontology>) {
    return (
        <TanStackDevtools
            plugins={[
                {
                    id: "party-stack-ontology",
                    name: (_element, { theme }) => <PartyStackPluginName theme={theme} />,
                    render: (_element, { theme }) => (
                        <OntologyPanel ontology={ontology as LiveOntology} theme={theme} />
                    ),
                    defaultOpen: true,
                },
            ]}
            config={{
                customTrigger: (_element, { theme }) => <OntologyTrigger theme={theme} />,
            }}
        />
    );
}
