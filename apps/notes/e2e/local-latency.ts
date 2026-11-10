import { isCollection, type Collection } from "@tanstack/db";
import { queryConsumers } from "../../../packages/ontology-devtools/lib/attribution/registry.js";
import { queryDemandGraph } from "../../../packages/ontology-devtools/lib/attribution/tanstack.js";

type Timing = {
    start: number;
    id?: string;
    handler?: number;
    source?: number;
    query?: number;
    mounted?: number;
    focus?: number;
    paint?: number;
};
export function recordNewNotes(folder: string) {
    const records: Timing[] = [];
    const subscriptions: { unsubscribe(): void }[] = [];
    const sources = new Set<Collection<object>>();
    for (const consumer of queryConsumers())
        for (const demand of queryDemandGraph(consumer.collection))
            if (demand.objectType === "Note" && isCollection(demand.collection))
                sources.add(demand.collection);
    const current = () => records.at(-1);
    for (const source of sources)
        subscriptions.push(
            source.subscribeChanges(
                (batch) => {
                    const timing = current();
                    if (!timing || timing.source !== undefined) return;
                    const added = batch.find(
                        (change) =>
                            change.type === "insert" && Reflect.get(change.value, "notebookId") === folder
                    );
                    if (added) {
                        timing.id = String(added.key);
                        timing.source = performance.now() - timing.start;
                    }
                },
                { includeInitialState: false }
            )
        );
    for (const consumer of queryConsumers()) {
        if (consumer.owner.name !== "NoteList" || !isCollection(consumer.collection)) continue;
        subscriptions.push(
            consumer.collection.subscribeChanges(
                (batch) => {
                    const timing = current();
                    if (
                        timing?.id &&
                        timing.query === undefined &&
                        batch.some(
                            (change) =>
                                change.type !== "delete" && Reflect.get(change.value, "id") === timing.id
                        )
                    )
                        timing.query = performance.now() - timing.start;
                },
                { includeInitialState: false }
            )
        );
    }
    const starts = (event: MouseEvent) => {
        if ((event.target as Element).closest('[role="menuitem"]')?.textContent?.trim() === "Note")
            records.push({ start: performance.now() });
    };
    const ends = (event: MouseEvent) => {
        if ((event.target as Element).closest('[role="menuitem"]')?.textContent?.trim() === "Note") {
            const timing = current();
            if (timing) timing.handler = performance.now() - timing.start;
        }
    };
    const focus = (event: FocusEvent) => {
        const target = event.target as Element;
        const timing = current();
        if (
            !timing ||
            target.getAttribute("aria-label") !== "Note content" ||
            target.closest<HTMLElement>(".note-page")?.dataset.noteId !== timing.id ||
            timing.focus !== undefined
        )
            return;
        timing.focus = performance.now() - timing.start;
        requestAnimationFrame(() => {
            timing.paint = performance.now() - timing.start;
        });
    };
    const observer = new MutationObserver(() => {
        const timing = current();
        if (!timing?.id || timing.mounted !== undefined) return;
        if (document.querySelector(`.note-page[data-note-id="${timing.id}"] [aria-label="Note content"]`))
            timing.mounted = performance.now() - timing.start;
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("click", starts, true);
    document.addEventListener("click", ends);
    document.addEventListener("focusin", focus, true);
    return {
        records,
        stop() {
            subscriptions.forEach((s) => s.unsubscribe());
            observer.disconnect();
            document.removeEventListener("click", starts, true);
            document.removeEventListener("click", ends);
            document.removeEventListener("focusin", focus, true);
        },
    };
}

/** Observe cached navigation without changing the application's query path. */
export function recordKeyboardNavigation() {
    const records: { id: string; start: number; ready?: number; keptListFocus?: boolean }[] = [];
    const check = () => {
        const current = records.at(-1);
        if (!current || current.ready !== undefined) return;
        if (!document.querySelector(`.note-page[data-note-id="${current.id}"] [aria-label="Note content"]`))
            return;
        current.ready = performance.now() - current.start;
        current.keptListFocus = !!document.activeElement?.closest(".note-preview");
    };
    const keydown = (event: KeyboardEvent) => {
        if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
        const row = (event.target as HTMLElement).closest(".note-preview");
        const list = row?.closest('[role="listbox"]');
        if (!list) return;
        const rows = [...list.querySelectorAll<HTMLElement>(".note-preview")];
        const index = rows.indexOf(row as HTMLElement);
        const next =
            rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
        if (!next?.dataset.noteId) return;
        records.push({ id: next.dataset.noteId, start: performance.now() });
        queueMicrotask(check);
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    document.addEventListener("keydown", keydown, true);
    return {
        records,
        stop() {
            observer.disconnect();
            document.removeEventListener("keydown", keydown, true);
        },
    };
}
