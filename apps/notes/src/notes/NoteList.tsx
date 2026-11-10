import {
    defineListFragment,
    useListFragment,
    useOntology,
    type ListFragmentRef,
    type ListFragmentData,
} from "@party-stack/ontology-react";
import {
    eq,
    ilike,
    or,
    type Collection,
    type LiveQueryCollectionUtils,
    type NonSingleResult,
} from "@tanstack/db";
import { useNavigate } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import {
    Suspense,
    startTransition,
    useCallback,
    useEffect,
    useDeferredValue,
    useLayoutEffect,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { objects } from "../ontology/generated/collections";
import { useBootSignal } from "./bootContext";
import { collectionLocation, noteLocation } from "./navigation";
import { NoteListScroll } from "./NoteListScroll";
import { NotePreview, notePreviewFragment } from "./NotePreview";
import { GlassButton, textError, useMobileLayout, VisibleViewTransition as ViewTransition } from "./ui";
import { useNoteDates } from "./useNoteDates";
import { useWorkspace } from "./workspaceContext";
import type { NotesOntology } from "../ontology/generated/types";

const transitionName = (kind: string, id: string) =>
    `notes-${kind}-${[...id].map((char) => char.codePointAt(0)!.toString(16)).join("-")}`;

export type NotesListProps = {
    view: string;
    search: string;
    selectedId?: string;
    heading: (count: number, view: string, more?: boolean) => ReactNode;
};

export const noteListFragment = defineListFragment(
    objects.Note,
    (notes, { search = "", trashed = false, limit = 50 }) => {
        let query = notes.where(({ row }) => eq(row.trashed, trashed));
        if (search.trim())
            query = query.where(({ row }) =>
                or(ilike(row.title, `%${search.trim()}%`), ilike(row.bodyMarkdown, `%${search.trim()}%`))
            );
        if (!trashed) query = query.orderBy(({ row }) => row.favorite, "desc");
        return query
            .orderBy(({ row }) => row.updatedAt, "desc")
            .orderBy(({ row }) => row.id, "asc")
            .limit(limit)
            .select(({ row }) => ({
                id: row.id,
                pinned: trashed ? false : row.favorite,
                updatedAt: row.updatedAt,
                preview: notePreviewFragment.include(row),
            }));
    }
);
export type NoteListRootCollection = Collection<
    ListFragmentData<typeof noteListFragment>,
    string | number,
    LiveQueryCollectionUtils
> &
    NonSingleResult;

export function NoteList({
    view,
    search,
    selectedId,
    heading,
    notes,
}: NotesListProps & {
    notes:
        | ListFragmentRef<typeof noteListFragment>
        | NoteListRootCollection
        | ReturnType<typeof noteListFragment.query>;
}) {
    const ontology = useOntology<NotesOntology>();
    const dates = useNoteDates();
    const mobile = useMobileLayout();
    const previousSelection = useRef<{ id: string; view: string; search: string; index: number } | undefined>(
        undefined
    );
    const viewport = useRef<HTMLDivElement>(null);
    const dateHeading = useRef<HTMLHeadingElement>(null);
    const [activeGroup, setActiveGroup] = useState<string>();
    const { reportError, requestEditorFocus, cancelEditorFocus, focusFolders } = useWorkspace();
    const navigate = useNavigate();
    const { data, hasNextPage: hasMore, isFetchingNextPage: pending, fetchNextPage } = useListFragment(notes);
    // Track only the selection's position, not a second copy of query rows.
    // The live list decides where to go when a selected row leaves the view.
    useLayoutEffect(() => {
        const previous = previousSelection.current;
        const index = data.findIndex((note) => note.id === selectedId);
        previousSelection.current =
            selectedId && index >= 0 ? { id: selectedId, view, search, index } : undefined;
        if (
            index >= 0 ||
            !selectedId ||
            previous?.id !== selectedId ||
            previous.view !== view ||
            previous.search !== search
        )
            return;
        const next = data[Math.min(previous.index, data.length - 1)];
        void navigate(!mobile && next ? noteLocation(view, next.id) : collectionLocation(view));
    }, [data, selectedId, view, search, mobile, navigate]);
    const select = useCallback(
        (id: string) => {
            cancelEditorFocus();
            startTransition(() => {
                void navigate(noteLocation(view, id));
            });
        },
        [cancelEditorFocus, navigate, view]
    );
    useBootSignal("list");
    // The query remains authoritative. Defer only its rendered ordering so
    // React can animate layout changes from the external store.
    const displayed = useDeferredValue(data);
    const groups: { label: string; entries: (typeof data)[number][] }[] = [];
    for (const entry of displayed) {
        const label = entry.pinned ? "Pinned" : dates.group(entry.updatedAt);
        let group = groups.at(-1);
        if (!group || group.label !== label) {
            group = { label, entries: [] };
            groups.push(group);
        }
        group.entries.push(entry);
    }
    const sectionKey = groups.map((group) => group.label).join("|");
    const layout = JSON.stringify(
        groups.map((group) => [group.label, group.entries.map((entry) => entry.id)])
    );
    const previousLayout = useRef<string | undefined>(undefined);
    const moving = previousLayout.current !== undefined && previousLayout.current !== layout;
    useLayoutEffect(() => {
        previousLayout.current = layout;
    }, [layout]);
    const currentGroup = groups.find((group) => group.label === activeGroup)?.label ?? groups[0]?.label;
    useEffect(() => {
        const root = viewport.current;
        const heading = dateHeading.current;
        if (!root || !heading) return;
        const sections = Array.from(root.querySelectorAll<HTMLElement>(".date-section"));
        const visible = new Set<Element>();
        let observer: IntersectionObserver | undefined;
        let offset = -1;
        const observe = () => {
            const next = heading.getBoundingClientRect().top - root.getBoundingClientRect().top;
            if (next === offset) return;
            offset = next;
            observer?.disconnect();
            visible.clear();
            observer = new IntersectionObserver(
                (entries) => {
                    for (const entry of entries) {
                        if (entry.isIntersecting) visible.add(entry.target);
                        else visible.delete(entry.target);
                    }
                    const first = sections.find((section) => visible.has(section));
                    if (first) setActiveGroup(first.dataset.dateGroup);
                },
                { root, rootMargin: `-${offset}px 0px 0px` }
            );
            for (const section of sections) observer.observe(section);
        };
        observe();
        const resize = new ResizeObserver(observe);
        resize.observe(heading);
        return () => {
            observer?.disconnect();
            resize.disconnect();
        };
    }, [sectionKey]);
    return (
        <>
            {heading(data.length, view, hasMore)}
            {currentGroup && (
                <h2 className="date-group list-date-heading" ref={dateHeading}>
                    <span key={currentGroup}>{currentGroup}</span>
                </h2>
            )}
            <NoteListScroll viewportRef={viewport}>
                <div
                    className="entries"
                    role="listbox"
                    tabIndex={-1}
                    aria-label="Notes"
                    onKeyDown={(event) => {
                        if ((event.key === "Backspace" || event.key === "Delete") && view !== "trash") {
                            const current = (event.target as HTMLElement).closest<HTMLButtonElement>(
                                ".note-preview"
                            );
                            if (!current?.dataset.noteId) return;
                            event.preventDefault();
                            const buttons = Array.from(
                                event.currentTarget.querySelectorAll<HTMLButtonElement>(".note-preview")
                            );
                            const index = buttons.indexOf(current);
                            const next = buttons[index + 1] ?? buttons[index - 1];
                            void ontology.actions
                                .updateNote({ note: current.dataset.noteId, trashed: true })
                                .catch((cause) => reportError(textError(cause)));
                            cancelEditorFocus();
                            next?.focus();
                            // The optimistic live-list update owns selection recovery,
                            // just as it does for toolbar and context-menu deletion.
                            // Navigating here too races that update with a second load
                            // of the same route while Router is committing the first.
                            return;
                        }
                        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                            event.preventDefault();
                            const buttons = Array.from(
                                event.currentTarget.querySelectorAll<HTMLButtonElement>(".note-preview")
                            );
                            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                            const next =
                                event.key === "Home"
                                    ? 0
                                    : event.key === "End"
                                      ? buttons.length - 1
                                      : Math.max(
                                            0,
                                            Math.min(
                                                buttons.length - 1,
                                                index + (event.key === "ArrowDown" ? 1 : -1)
                                            )
                                        );
                            buttons[next]?.focus();
                            buttons[next]?.click();
                        }
                        if (event.key === "ArrowRight") {
                            event.preventDefault();
                            const current = (event.target as HTMLElement).closest<HTMLButtonElement>(
                                ".note-preview"
                            );
                            const id = current?.dataset.noteId ?? selectedId;
                            if (id) {
                                current?.click();
                                requestEditorFocus(id);
                            }
                        } else if (event.key === "ArrowLeft") {
                            event.preventDefault();
                            focusFolders();
                        }
                    }}
                >
                    {groups.map((group) => (
                        <div
                            className="date-section"
                            role="group"
                            aria-label={group.label}
                            key={group.label}
                            data-date-group={group.label}
                            data-current={group.label === currentGroup || undefined}
                        >
                            <ViewTransition
                                name={transitionName("section", group.label)}
                                default="none"
                                update={
                                    moving ? { "notes-panels": "none", default: "notes-row-move" } : "none"
                                }
                            >
                                <h2 className="date-group">{group.label}</h2>
                            </ViewTransition>
                            {group.entries.map((entry) => (
                                <ViewTransition
                                    key={entry.id}
                                    name={transitionName("row", entry.id)}
                                    default="none"
                                    enter="notes-row-appear"
                                    exit="notes-row-disappear"
                                    update={
                                        moving
                                            ? { "notes-panels": "none", default: "notes-row-move" }
                                            : "none"
                                    }
                                    share={
                                        moving
                                            ? { "notes-panels": "none", default: "notes-row-move" }
                                            : "none"
                                    }
                                >
                                    <Suspense fallback={<div className="preview-skeleton" />}>
                                        <NotePreview
                                            note={entry.preview}
                                            dates={dates}
                                            selected={selectedId === entry.id}
                                            tabIndex={
                                                selectedId === entry.id ||
                                                (!selectedId && data[0]?.id === entry.id)
                                                    ? 0
                                                    : -1
                                            }
                                            onSelect={select}
                                        />
                                    </Suspense>
                                </ViewTransition>
                            ))}
                        </div>
                    ))}
                    {!data.length && (
                        <div className="empty-list">
                            <FileText />
                            <p>
                                {view === "trash"
                                    ? "No recently deleted notes"
                                    : search
                                      ? "No matching notes"
                                      : "No notes here yet"}
                            </p>
                        </div>
                    )}
                    {hasMore && (
                        <div className="list-load-more">
                            <GlassButton
                                disabled={pending}
                                onClick={() =>
                                    void fetchNextPage().catch((cause) => reportError(textError(cause)))
                                }
                            >
                                {pending ? "Loading…" : "Load more"}
                            </GlassButton>
                        </div>
                    )}
                </div>
            </NoteListScroll>
        </>
    );
}
