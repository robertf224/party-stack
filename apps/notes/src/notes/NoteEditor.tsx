import {
    defineFragment,
    useFragment,
    useOntology,
    type FragmentData,
    type FragmentRef,
} from "@party-stack/ontology-react";
import { eq, Query, type QueryResult } from "@tanstack/db";
import { useLiveSuspenseQuery } from "@tanstack/react-db";
import { Archive, Ellipsis, FileText, Pin, Trash2 } from "lucide-react";
import { Suspense } from "react";
import { createPortal } from "react-dom";
import { objects } from "../ontology/generated/collections";
import { useBootSignal } from "./bootContext";
import { NoteMenu, noteMenuFragment, noteShareFragment, ShareNoteButton } from "./NoteMenu";
import { RichEditor, richEditorFragment } from "./RichEditor";
import { SecretEditor, secretEditorFragment } from "./SecretEditor";
import { EditorLoading, IconButton, textError } from "./ui";
import { useWorkspace } from "./workspaceContext";
import type { NotesOntology } from "../ontology/generated/types";

export function NotePage({ noteId }: { noteId: string }) {
    return (
        <Suspense key={noteId} fallback={<EditorLoading />}>
            <NoteQuery noteId={noteId} />
        </Suspense>
    );
}

function MissingNote() {
    return (
        <div className="editor-empty">
            <FileText />
            <span>This note isn’t available.</span>
        </div>
    );
}

export function noteQuery(noteId: string) {
    return new Query()
        .from({ note: objects.Note })
        .where(({ note }) => eq(note.id, noteId))
        .select(({ note }) => ({ document: documentEditorFragment.include(note) }))
        .findOne();
}
type NoteQueryData = QueryResult<ReturnType<typeof noteQuery>>;
function NoteQuery({ noteId }: { noteId: string }) {
    const { data } = useLiveSuspenseQuery(() => noteQuery(noteId));
    return <NoteQueryView noteId={noteId} data={data} />;
}
function NoteQueryView({ noteId, data }: { noteId: string; data: NoteQueryData | undefined }) {
    useBootSignal("editor");
    return (
        <div className="note-page" data-note-id={noteId}>
            {data ? <DocumentEditor key={noteId} note={data.document} /> : <MissingNote />}
        </div>
    );
}

export const documentEditorFragment = defineFragment(objects.Note, (note) => ({
    id: note.id,
    kind: note.kind,
    favorite: note.favorite,
    trashed: note.trashed,
    updatedAt: note.updatedAt,
    menu: noteMenuFragment.include(note),
    share: noteShareFragment.include(note),
    richText: richEditorFragment.include(note),
    vault: secretEditorFragment.include(note),
}));

function DocumentEditor({ note }: { note: FragmentRef<typeof documentEditorFragment> }) {
    const { data: value } = useFragment(note);
    return value ? <DocumentEditorContent value={value} /> : <MissingNote />;
}

function DocumentEditorContent({ value }: { value: FragmentData<typeof documentEditorFragment> }) {
    const ontology = useOntology<NotesOntology>();
    const { reportError, actionsTarget, cancelEditorFocus } = useWorkspace();
    const update = (parameters: Partial<NotesOntology["actionTypes"]["updateNote"]["parameters"]>) =>
        void ontology.actions
            .updateNote({ ...parameters, note: value.id })
            .catch((cause) => reportError(textError(cause)));
    return (
        <>
            {actionsTarget &&
                createPortal(
                    <div className="toolbar-actions">
                        <IconButton
                            label={value.favorite ? "Unpin note" : "Pin note"}
                            active={value.favorite}
                            disabled={value.trashed}
                            onClick={() => update({ favorite: !value.favorite })}
                        >
                            <Pin size={18} />
                        </IconButton>
                        <IconButton
                            label={value.trashed ? "Restore note" : "Move to recently deleted"}
                            onClick={() => {
                                cancelEditorFocus();
                                update({ trashed: !value.trashed });
                            }}
                        >
                            {value.trashed ? <Archive size={18} /> : <Trash2 size={18} />}
                        </IconButton>
                        {value.kind === "note" && <ShareNoteButton note={value.share} />}
                        <NoteMenu
                            note={value.menu}
                            trigger={
                                <IconButton label="Note options">
                                    <Ellipsis size={19} />
                                </IconButton>
                            }
                        />
                    </div>,
                    actionsTarget
                )}
            <article className="note-document">
                <div className="note-date">
                    {new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" }).format(
                        value.updatedAt.epochMilliseconds
                    )}
                </div>
                {value.kind === "note" ? (
                    <RichEditor note={value.richText} />
                ) : (
                    <SecretEditor key={value.kind} note={value.vault} />
                )}
            </article>
        </>
    );
}
