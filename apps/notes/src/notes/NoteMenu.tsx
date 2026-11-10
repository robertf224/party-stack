import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { defineFragment, useFragment, useOntology, type FragmentRef } from "@party-stack/ontology-react";
import { eq, queryOnce } from "@tanstack/db";
import { useLiveSuspenseQuery } from "@tanstack/react-db";
import { useNavigate } from "@tanstack/react-router";
import { Archive, ArrowUpRight, ChevronRight, Copy, Folder, Pin, Trash2 } from "lucide-react";
import { Suspense, type ReactElement } from "react";
import { defaultNotebookId } from "../ontology/folders";
import { objects } from "../ontology/generated/collections";
import { noteLocation } from "./navigation";
import { noteShareFragment, ShareMenuItem } from "./ShareNote";
import { textError } from "./ui";
export { noteShareFragment, ShareNoteButton } from "./ShareNote";
import { useWorkspace } from "./workspaceContext";
import type { NotesOntology } from "../ontology/generated/types";

export const noteMenuFragment = defineFragment(objects.Note, (note) => ({
    id: note.id,
    notebookId: note.notebookId,
    kind: note.kind,
    favorite: note.favorite,
    trashed: note.trashed,
    share: noteShareFragment.include(note),
}));

export function NoteMenu({
    note,
    trigger,
    contextMenu = false,
}: {
    note: FragmentRef<typeof noteMenuFragment>;
    trigger: ReactElement;
    contextMenu?: boolean;
}) {
    const Parts = contextMenu ? ContextMenu : Menu;
    // The list owns its row's lifetime. Keep the trigger mounted while a
    // deletion transition captures it; only open menus subscribe to menu data.
    return (
        <Parts.Root>
            <Parts.Trigger render={trigger} />
            <Parts.Portal>
                <Parts.Positioner className="menu-positioner" sideOffset={6} align="start">
                    <Parts.Popup className="glass-menu">
                        <Suspense
                            fallback={
                                <Parts.Item className="menu-item" disabled>
                                    Loading…
                                </Parts.Item>
                            }
                        >
                            <NoteMenuContent note={note} Parts={Parts} />
                        </Suspense>
                    </Parts.Popup>
                </Parts.Positioner>
            </Parts.Portal>
        </Parts.Root>
    );
}

function NoteMenuContent({
    note: reference,
    Parts,
}: {
    note: FragmentRef<typeof noteMenuFragment>;
    Parts: typeof Menu | typeof ContextMenu;
}) {
    const { data: note } = useFragment(reference);
    const ontology = useOntology<NotesOntology>();
    const { view, reportError } = useWorkspace();
    const navigate = useNavigate();
    if (!note) return null;
    const noteId = note.id;
    const update = (parameters: Partial<NotesOntology["actionTypes"]["updateNote"]["parameters"]>) =>
        void ontology.actions
            .updateNote({ note: noteId, ...parameters })
            .catch((cause) => reportError(textError(cause)));
    async function duplicate() {
        try {
            const [original] = await queryOnce((q) =>
                q.from({ item: ontology.objects.Note }).where(({ item }) => eq(item.id, noteId))
            );
            if (!original) return;
            const id = crypto.randomUUID();
            await ontology.actions.createNote({
                id,
                notebookId: original.notebookId,
                title: original.title,
                kind: original.kind,
                secret: original.secret,
            });
            let body = original.bodyMarkdown;
            const attached = await queryOnce((q) =>
                q.from({ item: ontology.objects.NoteAttachment }).where(({ item }) => eq(item.noteId, noteId))
            );
            for (const item of attached) {
                if (!body.includes(`attachment:${item.id}`)) continue;
                const attachmentId = crypto.randomUUID();
                await ontology.actions.addAttachment({ id: attachmentId, noteId: id, file: item.file });
                body = body.replaceAll(`attachment:${item.id}`, `attachment:${attachmentId}`);
            }
            await ontology.actions.updateNote({ note: id, bodyMarkdown: body });
            void navigate(noteLocation(view, id));
        } catch (cause) {
            reportError(textError(cause));
        }
    }
    return (
        <>
            <Parts.LinkItem
                className="menu-item"
                href={
                    note.notebookId === defaultNotebookId(ontology.context.userId)
                        ? `/notes/${encodeURIComponent(note.id)}`
                        : `/folders/${encodeURIComponent(note.notebookId)}/${encodeURIComponent(note.id)}`
                }
                target="_blank"
                rel="noopener noreferrer"
            >
                <ArrowUpRight />
                Open in new tab
            </Parts.LinkItem>
            <Parts.Separator className="menu-separator" />
            {!note.trashed && (
                <Parts.Item className="menu-item" onClick={() => update({ favorite: !note.favorite })}>
                    <Pin />
                    {note.favorite ? "Unpin note" : "Pin note"}
                </Parts.Item>
            )}
            <Parts.Item className="menu-item" onClick={() => void duplicate()}>
                <Copy />
                Duplicate note
            </Parts.Item>
            {note.kind === "note" && <ShareMenuItem Parts={Parts} note={note.share} />}
            {!note.trashed && (
                <Parts.SubmenuRoot>
                    <Parts.SubmenuTrigger className="menu-item">
                        <Folder />
                        Move to
                        <ChevronRight className="submenu-chevron" />
                    </Parts.SubmenuTrigger>
                    <Parts.Portal>
                        <Parts.Positioner className="menu-positioner" sideOffset={5} alignOffset={-5}>
                            <Parts.Popup className="glass-menu">
                                <Suspense
                                    fallback={
                                        <Parts.Item className="menu-item" disabled>
                                            Loading…
                                        </Parts.Item>
                                    }
                                >
                                    <MoveFolders
                                        Parts={Parts}
                                        current={note.notebookId}
                                        move={(notebookId) => {
                                            update({ notebookId });
                                            void navigate(
                                                noteLocation(
                                                    notebookId === defaultNotebookId(ontology.context.userId)
                                                        ? "all"
                                                        : `folder:${notebookId}`,
                                                    note.id
                                                )
                                            );
                                        }}
                                    />
                                </Suspense>
                            </Parts.Popup>
                        </Parts.Positioner>
                    </Parts.Portal>
                </Parts.SubmenuRoot>
            )}
            <Parts.Separator className="menu-separator" />
            <Parts.Item
                className="menu-item"
                onClick={() => {
                    update({ trashed: !note.trashed });
                }}
            >
                {note.trashed ? <Archive /> : <Trash2 />}
                {note.trashed ? "Restore note" : "Delete note"}
            </Parts.Item>
        </>
    );
}

// Query only when the submenu is mounted. A closed menu must not suspend
// its note editor (or create one additional folder query per preview card).
function MoveFolders({
    Parts,
    current,
    move,
}: {
    Parts: typeof Menu | typeof ContextMenu;
    current: string;
    move: (id: string) => void;
}) {
    const ontology = useOntology<NotesOntology>();
    const { data: folders } = useLiveSuspenseQuery((q) =>
        q.from({ folder: objects.Notebook }).orderBy(({ folder }) => folder.name, "asc")
    );
    return folders.map((folder) => (
        <Parts.Item
            className="menu-item"
            key={folder.id}
            disabled={folder.id === current}
            onClick={() => move(folder.id)}
        >
            <Folder style={{ color: folder.color }} />
            {folder.id === defaultNotebookId(ontology.context.userId) ? "Notes" : folder.name}
        </Parts.Item>
    ));
}
