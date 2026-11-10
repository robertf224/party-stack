import { Dialog } from "@base-ui/react/dialog";
import { Input } from "@base-ui/react/input";
import { createOntologyDevtoolsPlugin, ontologyDevtoolsTrigger } from "@party-stack/ontology-devtools";
import { useOntology } from "@party-stack/ontology-react";
import { Query } from "@tanstack/db";
import { useLiveSuspenseQuery } from "@tanstack/react-db";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { Link, Outlet, useNavigate, useParams, useMatchRoute } from "@tanstack/react-router";
import {
    ChevronLeft,
    Ellipsis,
    Menu as MenuIcon,
    FileText,
    PanelLeft,
    Search,
    Trash2,
    X,
} from "lucide-react";
import {
    addTransitionType,
    startTransition,
    Suspense,
    useCallback,
    useContext,
    useDeferredValue,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { defaultNotebookId } from "../ontology/folders";
import { objects } from "../ontology/generated/collections";
import { BootContext } from "./bootContext";
import { FolderDownload } from "./FolderDownload";
import { folderLinkFragment } from "./FolderLink";
import { FolderMenu, folderMenuFragment } from "./FolderMenu";
import { Folders } from "./Folders";
import { folderTitleFragment } from "./FolderTitle";
import { ListTitle } from "./ListTitle";
import { collectionLocation, noteLocation } from "./navigation";
import { NewFolderDialog } from "./NewFolderDialog";
import { NewMenu } from "./NewMenu";
import { NoteListScroll } from "./NoteListScroll";
import { NotesListQuery } from "./NotesListQuery";
import { OutboxWarning } from "./OutboxWarning";
import { PaneDivider, usePanels } from "./panels";
import { SearchDialog } from "./SearchDialog";
import {
    BrandMark,
    VisibleViewTransition as ViewTransition,
    useCompactLayout,
    IconButton,
    EditorLoading,
    textError,
} from "./ui";
import { Workspace } from "./workspaceContext";
import type { NotesOntology, Note } from "../ontology/generated/types";

export function sidebarQuery() {
    return new Query()
        .from({ folder: objects.Notebook })
        .orderBy(({ folder }) => folder.name, "asc")
        .select(({ folder }) => ({
            id: folder.id,
            link: folderLinkFragment.include(folder),
            heading: folderTitleFragment.include(folder),
            menu: folderMenuFragment.include(folder),
        }));
}
export function NotesLayout() {
    useEffect(() => {
        // Load the editor code after the workspace commits, before the first
        // note selection. Its live queries still mount only with the note route.
        void import("./NoteEditor").catch(() => {
            // The route retries the import and owns any visible load error.
        });
    }, []);
    const ontology = useOntology<NotesOntology>();
    const { data: folders } = useLiveSuspenseQuery(sidebarQuery);
    const [error, reportError] = useState<string>();
    useEffect(() => {
        // Folder downloads replace the retired whole-device setting. Release its
        // legacy retention only; named folder downloads are independent.
        void ontology.pins
            .get()
            .then((legacy) => legacy && ontology.pins.clear())
            .catch((cause) => reportError(textError(cause)));
    }, [ontology]);
    const panels = usePanels(reportError);
    const compact = useCompactLayout();
    const { noteId, folderId } = useParams({ strict: false });
    const matchRoute = useMatchRoute();
    const view = folderId
        ? `folder:${folderId}`
        : matchRoute({ to: "/trash", fuzzy: true })
          ? "trash"
          : "all";
    // Route matching can finish before its live query. React retains the last
    // rendered folder while the next selection suspends, without copying rows.
    const displayedView = useDeferredValue(view);
    const pendingFolder = matchRoute({
        to: "/folders/$folderId",
        pending: true,
        fuzzy: true,
        includeSearch: false,
    });
    const pendingView = pendingFolder
        ? `folder:${pendingFolder.folderId}`
        : matchRoute({ to: "/trash", pending: true, fuzzy: true, includeSearch: false })
          ? "trash"
          : matchRoute({ to: "/", pending: true, includeSearch: false }) ||
              matchRoute({ to: "/notes/$noteId", pending: true, includeSearch: false })
            ? "all"
            : undefined;
    const selectedView = pendingView ?? view;
    const changingFolder = selectedView !== displayedView;
    const navigate = useNavigate();
    const [search, setSearch] = useState("");
    const deferredSearch = useDeferredValue(search);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    const [searchOpen, setSearchOpen] = useState(false);
    const [insertTarget, setInsertTarget] = useState<HTMLDivElement | null>(null);
    const [formatTarget, setFormatTarget] = useState<HTMLDivElement | null>(null);
    const [listCountTarget, setListCountTarget] = useState<HTMLSpanElement | null>(null);
    const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(null);
    const pendingEditorFocus = useRef<string | undefined>(undefined);
    const cancelEditorFocus = useCallback(() => {
        pendingEditorFocus.current = undefined;
    }, []);
    const claimEditorFocus = useCallback((id: string) => {
        if (pendingEditorFocus.current !== id) return false;
        pendingEditorFocus.current = undefined;
        return true;
    }, []);
    const requestEditorFocus = useCallback((id: string) => {
        pendingEditorFocus.current = id;
        const target = document.querySelector<HTMLElement>(
            `.note-page[data-note-id="${CSS.escape(id)}"] [aria-label="Note content"],.note-page[data-note-id="${CSS.escape(id)}"] [aria-label="Note title"]`
        );
        if (target && target.getClientRects().length) {
            target.focus();
            pendingEditorFocus.current = undefined;
        }
    }, []);
    const toggleFolders = useCallback(
        () =>
            startTransition(() => {
                addTransitionType("notes-panels");
                panels.toggle("folders");
            }),
        [panels.toggle]
    );
    const foldersNav = useRef<HTMLElement>(null);
    const pendingFolderFocus = useRef(false);
    const focusFolders = useCallback(() => {
        cancelEditorFocus();
        const selected = foldersNav.current?.querySelector<HTMLAnchorElement>('a[aria-current="page"]');
        if (selected) selected.focus();
        else {
            pendingFolderFocus.current = true;
            if (compact) setSidebarOpen(true);
            else toggleFolders();
        }
    }, [cancelEditorFocus, compact, toggleFolders]);
    useLayoutEffect(() => {
        if (!pendingFolderFocus.current) return;
        const selected = foldersNav.current?.querySelector<HTMLAnchorElement>('a[aria-current="page"]');
        if (selected) {
            pendingFolderFocus.current = false;
            selected.focus();
        }
    }, [compact, sidebarOpen, panels.sizes.folders]);
    useEffect(() => {
        function key(event: KeyboardEvent) {
            if (
                (event.metaKey || event.ctrlKey) &&
                event.key === "Enter" &&
                !event.altKey &&
                !event.shiftKey &&
                !event.isComposing &&
                noteId &&
                (event.target as Element).closest(".note-document")
            ) {
                event.preventDefault();
                event.stopPropagation();
                cancelEditorFocus();
                const focusRow = () =>
                    document
                        .querySelector<HTMLButtonElement>(
                            `.note-preview[data-note-id="${CSS.escape(noteId)}"]`
                        )
                        ?.focus();
                if (matchMedia("(max-width: 700px)").matches)
                    void navigate(collectionLocation(view)).then(() => requestAnimationFrame(focusRow));
                else focusRow();
                return;
            }
            if (
                (event.metaKey || event.ctrlKey) &&
                !event.altKey &&
                !event.shiftKey &&
                !event.isComposing &&
                event.key.toLowerCase() === "j"
            ) {
                event.preventDefault();
                event.stopPropagation();
                if (compact) setSidebarOpen((open) => !open);
                else toggleFolders();
                return;
            }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                if (matchMedia("(max-width: 1000px)").matches) setSearchOpen(true);
                else {
                    input.current?.focus();
                    input.current?.select();
                }
            }
        }
        document.addEventListener("keydown", key, true);
        return () => document.removeEventListener("keydown", key, true);
    }, [compact, toggleFolders, noteId, view, navigate, cancelEditorFocus]);
    const create = useCallback(
        async (kind: Note["kind"]) => {
            const id = crypto.randomUUID();
            requestEditorFocus(id);
            const notebookId = view.startsWith("folder:")
                ? view.slice(7)
                : defaultNotebookId(ontology.context.userId);
            void ontology.actions
                .createNote({
                    id,
                    notebookId,
                    kind,
                    title: kind === "login" ? "New login" : kind === "secure" ? "Secure note" : "",
                })
                .catch((cause) => reportError(textError(cause)));
            void navigate(noteLocation(view.startsWith("folder:") ? view : "all", id));
        },
        [ontology, navigate, view, requestEditorFocus]
    );
    useEffect(() => {
        const key = (event: KeyboardEvent) => {
            if (
                !event.shiftKey ||
                event.metaKey ||
                event.ctrlKey ||
                event.altKey ||
                event.repeat ||
                event.isComposing ||
                event.key.toLowerCase() !== "n" ||
                (event.target as Element).closest(
                    'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]'
                )
            )
                return;
            event.preventDefault();
            void create("note");
        };
        document.addEventListener("keydown", key);
        return () => document.removeEventListener("keydown", key);
    }, [create]);
    const devtools = useMemo(() => createOntologyDevtoolsPlugin({ ontology }), [ontology]);
    const context = useMemo(
        () => ({
            view,
            reportError,
            formatTarget,
            actionsTarget,
            insertTarget,
            requestEditorFocus,
            claimEditorFocus,
            cancelEditorFocus,
            focusFolders,
        }),
        [
            view,
            formatTarget,
            actionsTarget,
            insertTarget,
            requestEditorFocus,
            claimEditorFocus,
            cancelEditorFocus,
            focusFolders,
        ]
    );
    const nav = (id: string, name: string, icon: ReactNode, trailing?: ReactNode) => (
        <Link
            key={id}
            title={name}
            aria-label={name}
            {...collectionLocation(id)}
            className={`nav-item ${selectedView === id ? "selected" : ""}`}
            aria-current={selectedView === id ? "page" : undefined}
            tabIndex={selectedView === id ? 0 : -1}
            onClick={() => {
                cancelEditorFocus();
                setSidebarOpen(false);
                startTransition(() => setSearch(""));
            }}
        >
            {icon}
            <span className="folder-name">{name}</span>
            {trailing}
        </Link>
    );
    const sidebarContent = (
        <>
            <div className="brand">
                <BrandMark />
                <span>Notes</span>
                <NewFolderDialog />
                {compact && (
                    <Dialog.Close
                        render={
                            <IconButton label="Close menu">
                                <X size={21} />
                            </IconButton>
                        }
                    />
                )}
                {!compact && panels.sizes.folders > 0 && (
                    <ViewTransition name="notes-folders-toggle" default="none" share="notes-panel-button">
                        <IconButton
                            label="Hide folders"
                            aria-keyshortcuts="Meta+J Control+J"
                            onClick={toggleFolders}
                        >
                            <PanelLeft size={19} />
                        </IconButton>
                    </ViewTransition>
                )}
            </div>
            <nav
                aria-label="Notebooks"
                ref={foldersNav}
                onKeyDown={(event) => {
                    const current = (event.target as HTMLElement).closest<HTMLAnchorElement>("a.nav-item");
                    if (!current) return;
                    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                        event.preventDefault();
                        const folders = Array.from(
                            event.currentTarget.querySelectorAll<HTMLAnchorElement>("a.nav-item")
                        );
                        const index = folders.indexOf(current);
                        const next =
                            event.key === "Home"
                                ? 0
                                : event.key === "End"
                                  ? folders.length - 1
                                  : Math.max(
                                        0,
                                        Math.min(
                                            folders.length - 1,
                                            index + (event.key === "ArrowDown" ? 1 : -1)
                                        )
                                    );
                        folders[next]?.focus();
                        // Keep the drawer open while choosing with a keyboard.
                        // On desktop, selection follows focus like the note list.
                        if (!compact) folders[next]?.click();
                    } else if (event.key === " ") {
                        event.preventDefault();
                        current.click();
                    } else if (event.key === "ArrowRight" && !compact) {
                        event.preventDefault();
                        if (changingFolder) return;
                        const note =
                            document.querySelector<HTMLButtonElement>(".note-preview.selected") ??
                            document.querySelector<HTMLButtonElement>(".note-preview");
                        if (!note || note.closest("[inert]")) return;
                        note.focus();
                        note.click();
                    }
                }}
            >
                <Folders nav={nav} folders={folders} />
                <div className="sidebar-bottom">{nav("trash", "Recently deleted", <Trash2 />)}</div>
            </nav>
        </>
    );
    const listHeading = (
        <>
            <header className="list-heading">
                {compact ? (
                    <Dialog.Trigger
                        render={
                            <IconButton className="sidebar-toggle" label="Open menu">
                                <MenuIcon size={22} />
                            </IconButton>
                        }
                    />
                ) : panels.sizes.folders === 0 ? (
                    <ViewTransition name="notes-folders-toggle" default="none" share="notes-panel-button">
                        <IconButton
                            label="Show folders"
                            aria-keyshortcuts="Meta+J Control+J"
                            onClick={toggleFolders}
                        >
                            <PanelLeft size={19} />
                        </IconButton>
                    </ViewTransition>
                ) : null}
                <div>
                    <h1>
                        <ListTitle
                            view={displayedView}
                            folder={folders.find((folder) => folder.id === displayedView.slice(7))?.heading}
                        />
                    </h1>
                    <span className="list-count" ref={setListCountTarget} />
                </div>
                {displayedView !== "trash" && (
                    <FolderDownload
                        folderId={
                            displayedView.startsWith("folder:")
                                ? displayedView.slice(7)
                                : defaultNotebookId(ontology.context.userId)
                        }
                    />
                )}
                {displayedView.startsWith("folder:") &&
                    displayedView.slice(7) !== defaultNotebookId(ontology.context.userId) &&
                    folders
                        .filter((folder) => folder.id === displayedView.slice(7))
                        .map((folder) => (
                            <FolderMenu
                                key={folder.id}
                                folder={folder.menu}
                                trigger={
                                    <IconButton label="Folder options">
                                        <Ellipsis size={21} />
                                    </IconButton>
                                }
                            />
                        ))}
                <IconButton
                    className="list-search-button"
                    label="Search notes"
                    onClick={() => setSearchOpen(true)}
                >
                    <Search size={21} />
                </IconButton>
                {displayedView !== "trash" && (
                    <span className="mobile-new">
                        <NewMenu create={create} />
                    </span>
                )}
            </header>
        </>
    );
    // The list owns its count; a portal places that live projection in the
    // persistent header without copying data into workspace state.
    const renderListCount = (count: number, listView: string, more = false) =>
        listCountTarget && listView === displayedView
            ? createPortal(`${count}${more ? "+" : ""} ${count === 1 ? "note" : "notes"}`, listCountTarget)
            : null;
    return (
        <ViewTransition default="none" enter="notes-fade">
            <Workspace value={context}>
                <Dialog.Root open={compact && sidebarOpen} onOpenChange={setSidebarOpen}>
                    <div
                        className={`notes-app${compact ? " compact-layout" : ""}${noteId ? " has-selection" : ""}${panels.sizes.folders === 0 ? " folders-collapsed" : ""}${panels.sizes.notes === 0 ? " notes-collapsed" : ""}`}
                        style={panels.style}
                    >
                        {compact ? (
                            <Dialog.Portal>
                                <Dialog.Backdrop className="sidebar-scrim" />
                                <Dialog.Popup
                                    className="sidebar sidebar-drawer open"
                                    initialFocus={() => {
                                        pendingFolderFocus.current = false;
                                        return (
                                            foldersNav.current?.querySelector<HTMLAnchorElement>(
                                                'a[aria-current="page"]'
                                            ) ?? true
                                        );
                                    }}
                                >
                                    <Dialog.Title className="sr-only">Folders</Dialog.Title>
                                    {sidebarContent}
                                </Dialog.Popup>
                            </Dialog.Portal>
                        ) : panels.sizes.folders > 0 ? (
                            <ViewTransition
                                name="notes-folders-panel"
                                default="none"
                                enter="folders-open"
                                exit="folders-close"
                            >
                                <aside className="sidebar">{sidebarContent}</aside>
                            </ViewTransition>
                        ) : (
                            <aside className="sidebar" aria-hidden="true" />
                        )}
                        <ViewTransition
                            name="notes-list-pane"
                            default="none"
                            update={{ "notes-panels": "notes-panel-move", default: "none" }}
                        >
                            <section className="note-list" aria-label="Notes list" aria-busy={changingFolder}>
                                {listHeading}
                                <div
                                    className="folder-query-view"
                                    data-navigation-pending={changingFolder || undefined}
                                >
                                    <Suspense fallback={<ListLoading />}>
                                        <NotesListQuery
                                            key={displayedView}
                                            view={displayedView}
                                            search={deferredSearch}
                                            selectedId={noteId}
                                            heading={renderListCount}
                                        />
                                    </Suspense>
                                </div>
                            </section>
                        </ViewTransition>
                        <PaneDivider pane="folders" panels={panels} />
                        <PaneDivider pane="notes" panels={panels} />
                        <ViewTransition
                            name="notes-editor-pane"
                            default="none"
                            update={{ "notes-panels": "notes-panel-move", default: "none" }}
                        >
                            <main className="note-main" aria-label="Note editor">
                                <header className="workspace-toolbar">
                                    <div className="toolbar-left">
                                        <Link
                                            className="icon-button back-to-list"
                                            activeOptions={{ exact: true }}
                                            {...collectionLocation(view)}
                                            aria-label="Back to notes"
                                        >
                                            <ChevronLeft size={25} />
                                            <span className="back-label">Back</span>
                                        </Link>
                                        {view !== "trash" && (
                                            <span className="desktop-new">
                                                <NewMenu create={create} />
                                            </span>
                                        )}
                                    </div>
                                    <div className="toolbar-middle" ref={setFormatTarget} />
                                    <div className="toolbar-right">
                                        <div className="insert-menu-slot" ref={setInsertTarget} />
                                        <div className="note-action-slot" ref={setActionsTarget} />
                                        <SearchBox input={input} search={search} setSearch={setSearch} />
                                        <IconButton
                                            className="mobile-search-button"
                                            label="Search notes"
                                            onClick={() => setSearchOpen(true)}
                                        >
                                            <Search size={21} />
                                        </IconButton>
                                        <Dialog.Trigger
                                            render={
                                                <IconButton className="note-menu-trigger" label="Open menu">
                                                    <MenuIcon size={22} />
                                                </IconButton>
                                            }
                                        />
                                    </div>
                                </header>
                                <div
                                    className="workspace-body"
                                    data-navigation-pending={changingFolder || undefined}
                                >
                                    {error && (
                                        <div className="error-banner" role="alert">
                                            {error}
                                            <IconButton
                                                label="Dismiss error"
                                                onClick={() => reportError(undefined)}
                                            >
                                                <X size={14} />
                                            </IconButton>
                                        </div>
                                    )}
                                    <Suspense fallback={null}>
                                        <OutboxWarning />
                                    </Suspense>
                                    <Suspense fallback={<EditorLoading />}>
                                        <Outlet />
                                    </Suspense>
                                </div>
                            </main>
                        </ViewTransition>
                        <TanStackDevtools
                            config={{ position: "bottom-right", customTrigger: ontologyDevtoolsTrigger }}
                            plugins={[devtools]}
                        />
                    </div>
                </Dialog.Root>
                <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
            </Workspace>
        </ViewTransition>
    );
}
function SearchBox({
    input,
    search,
    setSearch,
}: {
    input: import("react").RefObject<HTMLInputElement | null>;
    search: string;
    setSearch: (value: string) => void;
}) {
    return (
        <label className="search desktop-search">
            <Search size={16} />
            <Input
                ref={input}
                aria-label="Search notes"
                placeholder="Search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Escape") {
                        setSearch("");
                        input.current?.blur();
                    }
                    if (event.key === "ArrowDown") {
                        event.preventDefault();
                        document.querySelector<HTMLButtonElement>(".note-preview")?.focus();
                    }
                }}
            />
            {search && (
                <button aria-label="Clear search" onClick={() => setSearch("")}>
                    <X size={13} />
                </button>
            )}
        </label>
    );
}
export function EmptyNote() {
    return (
        <div className="editor-empty">
            <FileText size={42} strokeWidth={1} />
            <span>Select a note</span>
        </div>
    );
}
function ListLoading() {
    const { ready } = useContext(BootContext);
    if (!ready) return null;
    return (
        <NoteListScroll>
            <output aria-label="Opening folder" />
        </NoteListScroll>
    );
}
