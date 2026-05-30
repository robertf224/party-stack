import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { debounceStrategy, useLiveQuery, usePacedMutations } from "@tanstack/react-db";
import { ilike, or } from "@tanstack/db";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createLiveOntology } from "@party-stack/ontology";
import { createRemoteOntologyAdapter } from "@party-stack/remote-ontology/client";
import { createHttpRemoteOntologyTransport } from "@party-stack/remote-ontology/http";
import { notesOntology, type Note, type NotesOntologyDefinition } from "../ontology/notesOntology";

const demoUsers = ["ada@example.com", "grace@example.com", "linus@example.com"];

type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

function getInitialUserEmail(): string {
    return localStorage.getItem("remote-notes:user") ?? demoUsers[0]!;
}

function formatUpdatedAt(value: string | undefined): string {
    if (!value) return "Not saved yet";
    return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    }).format(new Date(value));
}

function getSaveStatusLabel(status: SaveStatus): string {
    switch (status) {
        case "pending":
            return "Autosave pending";
        case "saving":
            return "Saving...";
        case "saved":
            return "Saved";
        case "error":
            return "Save failed";
        case "idle":
            return "Autosave on";
    }
}

function createClientOntology(userEmail: string) {
    const adapter = createRemoteOntologyAdapter({
        ir: notesOntology,
        transport: createHttpRemoteOntologyTransport({
            url: "/api/remote-ontology/",
            headers: () => ({
                "x-demo-user-email": userEmail,
            }),
        }),
    });
    return createLiveOntology<NotesOntologyDefinition>({ ir: notesOntology, adapter });
}

function MarkdownPreview({ markdown }: { markdown: string }) {
    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
                h1: ({ children }) => (
                    <h1 className="mb-4 mt-6 text-3xl font-semibold text-slate-100 first:mt-0">{children}</h1>
                ),
                h2: ({ children }) => (
                    <h2 className="mb-3 mt-5 text-2xl font-semibold text-slate-100 first:mt-0">{children}</h2>
                ),
                h3: ({ children }) => (
                    <h3 className="mb-2 mt-4 text-xl font-semibold text-slate-100 first:mt-0">{children}</h3>
                ),
                p: ({ children }) => <p className="my-3 leading-7 text-slate-300">{children}</p>,
                a: ({ children, href }) => (
                    <a className="text-cyan-300 underline decoration-cyan-300/40 underline-offset-4" href={href}>
                        {children}
                    </a>
                ),
                ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-6 text-slate-300">{children}</ul>,
                ol: ({ children }) => (
                    <ol className="my-3 list-decimal space-y-1 pl-6 text-slate-300">{children}</ol>
                ),
                blockquote: ({ children }) => (
                    <blockquote className="my-4 border-l-2 border-cyan-300/60 pl-4 text-slate-300">
                        {children}
                    </blockquote>
                ),
                code: ({ children }) => (
                    <code className="rounded bg-white/10 px-1.5 py-0.5 text-sm text-cyan-100">{children}</code>
                ),
                pre: ({ children }) => (
                    <pre className="my-4 overflow-x-auto rounded-2xl border border-white/10 bg-slate-950 p-4 text-sm text-slate-200">
                        {children}
                    </pre>
                ),
                table: ({ children }) => (
                    <div className="my-4 overflow-x-auto">
                        <table className="min-w-full border-collapse text-left text-sm text-slate-300">{children}</table>
                    </div>
                ),
                th: ({ children }) => (
                    <th className="border border-white/10 bg-white/5 px-3 py-2 font-semibold text-slate-100">
                        {children}
                    </th>
                ),
                td: ({ children }) => <td className="border border-white/10 px-3 py-2">{children}</td>,
            }}
        >
            {markdown}
        </ReactMarkdown>
    );
}

function SearchIcon() {
    return (
        <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
            <path
                d="m21 21-4.35-4.35m1.35-5.15a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
            />
        </svg>
    );
}

function SelectChevron() {
    return (
        <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 20 20">
            <path
                d="m5 7.5 5 5 5-5"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.8"
            />
        </svg>
    );
}

type NotesLayoutProps = {
    selectedNoteId?: string;
    showEditor: boolean;
    hideListOnMobile?: boolean;
};

export function NotesHomePage() {
    return <NotesLayout showEditor={false} />;
}

export function NotePage({ noteId }: { noteId: string }) {
    return <NotesLayout selectedNoteId={noteId} showEditor hideListOnMobile />;
}

function NotesLayout({ selectedNoteId, showEditor, hideListOnMobile = false }: NotesLayoutProps) {
    const navigate = useNavigate();
    const [userEmail, setUserEmail] = useState(getInitialUserEmail);
    const [searchQuery, setSearchQuery] = useState("");
    const ontology = useMemo(() => createClientOntology(userEmail), [userEmail]);

    const trimmedSearchQuery = searchQuery.trim();
    const { data: notes } = useLiveQuery(
        (q) => {
            const notesQuery = q.from({ note: ontology.objects.Note });
            const filteredNotesQuery = trimmedSearchQuery
                ? notesQuery.where(({ note }) =>
                      or(
                          ilike(note.title, `%${trimmedSearchQuery}%`),
                          ilike(note.bodyMarkdown, `%${trimmedSearchQuery}%`)
                      )
                  )
                : notesQuery;

            return filteredNotesQuery
                .select(({ note }) => ({ ...note }))
                .orderBy(({ note }) => note.updatedAt, "desc");
        },
        [ontology, trimmedSearchQuery]
    );

    const noteRows = notes as unknown as Note[];

    async function switchUser(email: string) {
        localStorage.setItem("remote-notes:user", email);
        setUserEmail(email);
        await navigate({ to: "/" });
    }

    async function createNote() {
        const id = crypto.randomUUID();
        await ontology.actions
            .createNote({
                id,
                title: "Untitled note",
                bodyMarkdown: "# Untitled note\n\nStart writing...",
            })
            .mutationFn();
        await navigate({ to: "/notes/$noteId", params: { noteId: id } });
    }

    return (
        <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100 lg:flex-row">
            <aside
                className={`max-h-screen w-full shrink-0 flex-col border-white/10 bg-slate-900/80 lg:flex lg:w-80 lg:border-r ${
                    hideListOnMobile ? "hidden" : "flex border-b lg:border-b-0"
                }`}
            >
                <div className="border-b border-white/10 p-5">
                    <div className="flex items-center justify-between">
                        <h1 className="text-2xl font-semibold">Notes</h1>
                        <button
                            type="button"
                            onClick={createNote}
                            className="rounded-full bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300"
                        >
                            New
                        </button>
                    </div>

                    <label className="mt-5 block text-xs font-medium text-slate-400">
                        Demo user
                        <div className="relative mt-2 text-slate-500">
                            <select
                                value={userEmail}
                                onChange={(event) => void switchUser(event.target.value)}
                                className="w-full appearance-none rounded-xl border border-white/10 bg-slate-950 py-2 pl-3 pr-10 text-sm text-slate-100 outline-none transition focus:border-cyan-300"
                            >
                                {demoUsers.map((email) => (
                                    <option key={email} value={email}>
                                        {email}
                                    </option>
                                ))}
                            </select>
                            <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                                <SelectChevron />
                            </div>
                        </div>
                    </label>

                    <div className="relative mt-4 text-slate-500">
                        <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">
                            <SearchIcon />
                        </div>
                        <input
                            aria-label="Search notes"
                            type="search"
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            placeholder="Search..."
                            className="w-full rounded-xl border border-white/10 bg-slate-950 py-2 pl-9 pr-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-cyan-300"
                        />
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-3">
                    {noteRows.length === 0 ? (
                        <div className="rounded-2xl border border-dashed border-white/10 p-5 text-sm text-slate-400">
                            This user has no notes yet. Create one to exercise the remote action path.
                        </div>
                    ) : (
                        noteRows.map((note) => (
                            <Link
                                key={note.id}
                                to="/notes/$noteId"
                                params={{ noteId: note.id }}
                                className={`mb-2 block w-full rounded-2xl border p-4 text-left transition ${
                                    note.id === selectedNoteId
                                        ? "border-cyan-300/70 bg-cyan-300/10"
                                        : "border-white/10 bg-white/3 hover:border-white/20 hover:bg-white/6"
                                }`}
                            >
                                <div className="truncate font-medium text-slate-100">{note.title}</div>
                                <div className="mt-1 line-clamp-2 text-sm text-slate-400">
                                    {note.bodyMarkdown.replaceAll("#", "").trim() || "Empty note"}
                                </div>
                                <div className="mt-3 text-xs text-slate-500">
                                    {formatUpdatedAt(note.updatedAt)}
                                </div>
                            </Link>
                        ))
                    )}
                </div>
            </aside>

            <main className={`min-h-0 flex-1 flex-col ${showEditor ? "flex" : "hidden lg:flex"}`}>
                {showEditor && selectedNoteId ? (
                    <NoteEditor
                        note={noteRows.find((note) => note.id === selectedNoteId)}
                        noteId={selectedNoteId}
                        ontology={ontology}
                    />
                ) : (
                    <div className="flex flex-1 items-center justify-center p-8 text-center text-slate-500">
                        Select a note or create a new one.
                    </div>
                )}
            </main>
        </div>
    );
}

function NoteEditor({
    note,
    noteId,
    ontology,
}: {
    note: Note | undefined;
    noteId: string;
    ontology: ReturnType<typeof createClientOntology>;
}) {
    const navigate = useNavigate();
    const [draftTitle, setDraftTitle] = useState("");
    const [draftBody, setDraftBody] = useState("");
    const [showPreview, setShowPreview] = useState(true);
    const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");

    useEffect(() => {
        setSaveStatus("idle");
        setDraftTitle("");
        setDraftBody("");
    }, [noteId]);

    useEffect(() => {
        if (!note || (saveStatus !== "idle" && saveStatus !== "saved")) return;
        setDraftTitle(note.title);
        setDraftBody(note.bodyMarkdown);
    }, [note, saveStatus]);

    const autosaveNote = usePacedMutations<{
        id: string;
        changes: Pick<Partial<Note>, "title" | "bodyMarkdown">;
    }>({
        onMutate: ({ id, changes }) => {
            setSaveStatus("pending");
            ontology.objects.Note.update(id, (draft) => {
                Object.assign(draft, changes);
                draft.updatedAt = new Date().toISOString();
            });
        },
        mutationFn: async ({ transaction }) => {
            setSaveStatus("saving");
            try {
                await Promise.all(
                    transaction.mutations.map((mutation) => {
                        const modifiedNote = mutation.modified as Note;
                        const changes = mutation.changes as Partial<Note>;
                        return ontology.actions
                            .updateNote({
                                note: modifiedNote.id,
                                ...(typeof changes.title === "string" ? { title: changes.title } : {}),
                                ...(typeof changes.bodyMarkdown === "string"
                                    ? { bodyMarkdown: changes.bodyMarkdown }
                                    : {}),
                            })
                            .mutationFn();
                    })
                );
                setSaveStatus("saved");
            } catch (error) {
                setSaveStatus("error");
                throw error;
            }
        },
        strategy: debounceStrategy({ wait: 700 }),
    });

    async function saveNote(changes: Pick<Partial<Note>, "title" | "bodyMarkdown">) {
        const transaction = autosaveNote({ id: noteId, changes });
        await transaction.isPersisted.promise;
    }

    function updateDraftTitle(title: string) {
        setDraftTitle(title);
        void saveNote({ title });
    }

    function updateDraftBody(bodyMarkdown: string) {
        setDraftBody(bodyMarkdown);
        void saveNote({ bodyMarkdown });
    }

    async function deleteNote() {
        await ontology.actions.deleteNote({ note: noteId }).mutationFn();
        await navigate({ to: "/" });
    }

    if (!note && draftTitle === "" && draftBody === "") {
        return <div className="flex flex-1 items-center justify-center p-8 text-center text-slate-500">Loading note...</div>;
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="border-b border-white/10 p-4 sm:p-6">
                <div className="mb-4 lg:hidden">
                    <Link to="/" className="text-sm font-medium text-cyan-300 hover:text-cyan-200">
                        Back
                    </Link>
                </div>
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                    <div className="min-w-0 flex-1">
                        <input
                            value={draftTitle}
                            onChange={(event) => updateDraftTitle(event.target.value)}
                            className="w-full max-w-2xl rounded-2xl border border-white/10 bg-white/3 px-4 py-3 text-2xl font-semibold outline-none transition placeholder:text-slate-600 focus:border-cyan-300"
                            placeholder="Untitled note"
                        />
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                            <span>Updated {formatUpdatedAt(note?.updatedAt)}</span>
                            <span
                                className={
                                    saveStatus === "error"
                                        ? "text-red-300"
                                        : saveStatus === "saved"
                                          ? "text-cyan-300"
                                          : "text-slate-400"
                                }
                            >
                                {getSaveStatusLabel(saveStatus)}
                            </span>
                        </div>
                        <button
                            type="button"
                            onClick={() => setShowPreview((current) => !current)}
                            className="rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-200 transition hover:border-white/20 hover:bg-white/6"
                        >
                            {showPreview ? "Hide preview" : "Show preview"}
                        </button>
                        <button
                            type="button"
                            onClick={deleteNote}
                            className="rounded-lg border border-red-400/30 px-3 py-2 text-sm text-red-200 transition hover:bg-red-400/10"
                        >
                            Delete
                        </button>
                    </div>
                </div>
            </div>

            <div className={`grid min-h-0 flex-1 grid-cols-1 ${showPreview ? "lg:grid-cols-2" : "lg:grid-cols-1"}`}>
                <section
                    className={`flex min-h-[45vh] min-w-0 flex-col p-4 sm:p-6 ${
                        showPreview ? "border-b border-white/10 lg:border-b-0 lg:border-r" : ""
                    }`}
                >
                    <textarea
                        value={draftBody}
                        onChange={(event) => updateDraftBody(event.target.value)}
                        className="min-h-88 flex-1 resize-none rounded-2xl border border-white/10 bg-white/3 p-4 font-mono text-sm leading-6 text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-cyan-300"
                        placeholder="Write markdown..."
                    />
                </section>

                {showPreview ? (
                    <section className="min-h-[45vh] min-w-0 overflow-y-auto p-4 sm:p-8">
                        <article className="max-w-none">
                            <MarkdownPreview markdown={draftBody} />
                        </article>
                    </section>
                ) : null}
            </div>
        </div>
    );
}
