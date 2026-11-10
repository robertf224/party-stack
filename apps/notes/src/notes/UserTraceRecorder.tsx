import { useOntology } from "@party-stack/ontology-react";
import { useEffect, useRef } from "react";
import type { TraceRecord, TraceStore } from "@party-stack/runtime/tracing";

/** Temporary, explicit local diagnostics. No queries, rows, status payloads or error messages. */
export function UserTraceRecorder() {
    const ontology = useOntology();
    const session = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (
            !import.meta.env.DEV ||
            !["1", "true"].includes(new URLSearchParams(location.search).get("__trace") ?? "")
        )
            return;
        session.current ??= crypto.randomUUID();
        type Marker = {
            kind: string;
            stage: "start" | "ready" | "error";
            path: string;
            at: number;
            elapsedMs?: number;
            highlightMs?: number;
        };
        const markers: Marker[] = [];
        const tab = new Map<string, TraceRecord>();
        const parent = new Map<string, TraceRecord>();
        const stores = [
            [ontology.traces, tab],
            [ontology.diagnostics?.parent?.traces, parent],
        ] as const;
        const now = () => performance.timeOrigin + performance.now();
        let upload: ReturnType<typeof setTimeout> | undefined;
        let merge: ReturnType<typeof setTimeout> | undefined;
        let frame: number | undefined;
        let pending:
            | { kind: string; start: number; path?: string; noteId?: string; highlightMs?: number }
            | undefined;
        const collect = (
            store: TraceStore | undefined,
            into: Map<string, TraceRecord>,
            record?: TraceRecord
        ) => {
            for (const { error: _error, ...span } of record ? [record] : (store?.getSnapshot() ?? [])) {
                const key = `${span.traceId}:${span.id}`;
                const previous = into.get(key);
                if (
                    previous &&
                    previous.durationMs === span.durationMs &&
                    previous.outcome === span.outcome &&
                    previous.eventCount === span.eventCount
                )
                    continue;
                into.delete(key);
                into.set(key, span);
                if (span.outcome === "failure" && previous?.outcome !== "failure") save();
            }
            while (into.size > 600) into.delete(into.keys().next().value!);
        };
        const flush = () => {
            for (const [store, into] of stores) collect(store, into);
            void fetch("/__notes_trace", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    sessionId: session.current,
                    capturedAt: now(),
                    markers,
                    tab: [...tab.values()],
                    parent: [...parent.values()],
                }),
            }).catch(() => {});
        };
        const save = () => {
            clearTimeout(upload);
            upload = setTimeout(flush, 500);
        };
        const check = () => {
            frame = undefined;
            if (!pending) return;
            const elapsedMs = now() - pending.start;
            const rows = [...document.querySelectorAll<HTMLElement>(".note-preview")];
            const row = pending.noteId && rows.find((item) => item.dataset.noteId === pending!.noteId);
            if (row && row.getAttribute("aria-selected") === "true") pending.highlightMs ??= elapsedMs;
            const ready = pending.noteId
                ? [...document.querySelectorAll<HTMLElement>(".note-page")].some(
                      (item) =>
                          item.dataset.noteId === pending!.noteId && item.querySelector(".note-document")
                  )
                : location.pathname === pending.path &&
                  document.querySelector('.folder-query-view:not([aria-hidden="true"]) [role="listbox"]') &&
                  document.querySelector(".note-list")?.getAttribute("aria-busy") !== "true";
            if (!ready) return;
            markers.push({
                kind: pending.kind,
                stage: "ready",
                path: location.pathname,
                at: now(),
                elapsedMs,
                highlightMs: pending.highlightMs,
            });
            pending = undefined;
            save();
        };
        const changed = () => {
            frame ??= requestAnimationFrame(check);
        };
        const begin = (kind: string, path?: string, noteId?: string) => {
            clearTimeout(upload);
            pending = { kind, path, noteId, start: now() };
            markers.push({ kind, stage: "start", path: location.pathname, at: pending.start });
            if (markers.length > 120) markers.splice(0, markers.length - 120);
            changed();
        };
        const click = (event: MouseEvent) => {
            if (!(event.target instanceof Element)) return;
            const target = event.target;
            const row = target.closest<HTMLElement>(".note-preview");
            if (row?.dataset.noteId) {
                if (!event.isTrusted && pending?.kind === "key") return;
                begin("note", undefined, row.dataset.noteId);
            } else {
                const link = target.closest<HTMLAnchorElement>(".sidebar a");
                if (link) begin("folder", new URL(link.href).pathname);
            }
        };
        const key = (event: KeyboardEvent) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            if (!(event.target instanceof Element)) return;
            const row = event.target.closest<HTMLElement>(".note-preview");
            if (!row) return;
            const rows = [...row.closest('[role="listbox"]')!.querySelectorAll<HTMLElement>(".note-preview")];
            const next =
                rows[
                    Math.max(
                        0,
                        Math.min(rows.length - 1, rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1))
                    )
                ];
            begin("key", undefined, next?.dataset.noteId);
        };
        const failure = () => {
            markers.push({ kind: "error", stage: "error", path: location.pathname, at: now() });
            save();
        };
        const stops = stores.map(([store, into]) => {
            collect(store, into);
            return store?.subscribe((record) => {
                if (record) collect(store, into, record);
                else
                    merge ??= setTimeout(() => {
                        merge = undefined;
                        for (const [source, records] of stores) collect(source, records);
                    }, 100);
            });
        });
        const observer = new MutationObserver(changed);
        observer.observe(document.body, { subtree: true, childList: true, attributes: true });
        document.addEventListener("click", click, true);
        document.addEventListener("keydown", key, true);
        window.addEventListener("error", failure);
        window.addEventListener("unhandledrejection", failure);
        begin("initial", location.pathname);
        return () => {
            stops.forEach((stop) => stop?.());
            observer.disconnect();
            document.removeEventListener("click", click, true);
            document.removeEventListener("keydown", key, true);
            window.removeEventListener("error", failure);
            window.removeEventListener("unhandledrejection", failure);
            clearTimeout(upload);
            clearTimeout(merge);
            if (frame !== undefined) cancelAnimationFrame(frame);
        };
    }, [ontology]);
    return null;
}
