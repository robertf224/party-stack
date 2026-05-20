import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { createLiveOntology } from "@party-stack/ontology";
import { createRemoteOntologyAdapter } from "@party-stack/remote-ontology/client";
import { notesOntology, type Note, type NotesOntologyDefinition } from "../ontology/notesOntology";

export const Route = createFileRoute("/")({
    component: NotesApp,
});

const demoUsers = ["ada@example.com", "grace@example.com", "linus@example.com"];

function getInitialUserEmail(): string {
    return localStorage.getItem("remote-notes:user") ?? demoUsers[0]!;
}

function renderMarkdown(markdown: string) {
    return markdown.split("\n").map((line, index) => {
        if (line.startsWith("# ")) {
            return (
                <h1 key={index} className="mt-5 text-2xl font-semibold text-slate-100 first:mt-0">
                    {line.slice(2)}
                </h1>
            );
        }
        if (line.startsWith("## ")) {
            return (
                <h2 key={index} className="mt-4 text-lg font-semibold text-slate-100 first:mt-0">
                    {line.slice(3)}
                </h2>
            );
        }
        if (line.trim().length === 0) {
            return <div key={index} className="h-3" />;
        }
        return (
            <p key={index} className="leading-7 text-slate-300">
                {line}
            </p>
        );
    });
}

function NotesApp() {
    const [userEmail, setUserEmail] = useState(getInitialUserEmail);
    const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
    const [draftTitle, setDraftTitle] = useState("");
    const [draftBody, setDraftBody] = useState("");

    const ontology = useMemo(() => {
        const adapter = createRemoteOntologyAdapter({
            ir: notesOntology,
            url: "/api/remote-ontology/",
            headers: () => ({
                "x-demo-user-email": userEmail,
            }),
        });
        return createLiveOntology<NotesOntologyDefinition>({ ir: notesOntology, adapter });
    }, [userEmail]);

    const { data: notes } = useLiveQuery(
        (q) =>
            q
                .from({ note: ontology.objects.Note })
                .select(({ note }) => ({ ...note }))
                .orderBy(({ note }) => note.updatedAt, "desc"),
        [ontology]
    );

    const noteRows = notes as unknown as Note[];
    const selectedNote = noteRows.find((note) => note.id === selectedNoteId) ?? null;

    function switchUser(email: string) {
        localStorage.setItem("remote-notes:user", email);
        setUserEmail(email);
        setSelectedNoteId(null);
        setDraftTitle("");
        setDraftBody("");
    }

    async function createNote() {
        const id = crypto.randomUUID();
        const title = "Untitled note";
        const bodyMarkdown = "# Untitled note\n\nStart writing...";
        await ontology.actions.createNote({ id, title, bodyMarkdown }).mutationFn();
        setSelectedNoteId(id);
        setDraftTitle(title);
        setDraftBody(bodyMarkdown);
    }

    function selectNote(note: Note) {
        setSelectedNoteId(note.id);
        setDraftTitle(note.title);
        setDraftBody(note.bodyMarkdown);
    }

    async function saveNote() {
        if (!selectedNote) return;
        await ontology.actions
            .updateNote({
                note: selectedNote.id,
                title: draftTitle,
                bodyMarkdown: draftBody,
            })
            .mutationFn();
    }

    async function deleteNote() {
        if (!selectedNote) return;
        await ontology.actions.deleteNote({ note: selectedNote.id }).mutationFn();
        setSelectedNoteId(null);
        setDraftTitle("");
        setDraftBody("");
    }

    return (
        <div className="flex min-h-screen bg-slate-950 text-slate-100">
            <aside className="flex w-80 shrink-0 flex-col border-r border-white/10 bg-slate-900/80">
                <div className="border-b border-white/10 p-5">
                    <div className="flex items-center justify-between">
                        <div>
                            <div className="text-xs font-medium uppercase tracking-[0.2em] text-cyan-300">
                                Remote Ontology
                            </div>
                            <h1 className="mt-1 text-2xl font-semibold">Notes</h1>
                        </div>
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
                        <select
                            value={userEmail}
                            onChange={(event) => switchUser(event.target.value)}
                            className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-cyan-300"
                        >
                            {demoUsers.map((email) => (
                                <option key={email} value={email}>
                                    {email}
                                </option>
                            ))}
                        </select>
                    </label>
                </div>

                <div className="flex-1 overflow-y-auto p-3">
                    {noteRows.length === 0 ? (
                        <div className="rounded-2xl border border-dashed border-white/10 p-5 text-sm text-slate-400">
                            This user has no notes yet. Create one to exercise the remote action path.
                        </div>
                    ) : (
                        noteRows.map((note) => (
                            <button
                                key={note.id}
                                type="button"
                                onClick={() => selectNote(note)}
                                className={`mb-2 w-full rounded-2xl border p-4 text-left transition ${
                                    note.id === selectedNoteId
                                        ? "border-cyan-300/70 bg-cyan-300/10"
                                        : "bg-white/3 hover:bg-white/6 border-white/10 hover:border-white/20"
                                }`}
                            >
                                <div className="truncate font-medium text-slate-100">{note.title}</div>
                                <div className="mt-1 line-clamp-2 text-sm text-slate-400">
                                    {note.bodyMarkdown.replaceAll("#", "").trim() || "Empty note"}
                                </div>
                                <div className="mt-3 text-xs text-slate-500">
                                    {new Date(note.updatedAt).toLocaleString()}
                                </div>
                            </button>
                        ))
                    )}
                </div>
            </aside>

            <main className="grid flex-1 grid-cols-2">
                <section className="flex min-w-0 flex-col border-r border-white/10">
                    <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
                        <div>
                            <div className="text-sm text-slate-400">Editor</div>
                            <div className="text-xs text-slate-500">
                                Server injects ownership and filters every subset by user.
                            </div>
                        </div>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                disabled={!selectedNote}
                                onClick={deleteNote}
                                className="rounded-lg border border-red-400/30 px-3 py-2 text-sm text-red-200 transition enabled:hover:bg-red-400/10 disabled:opacity-40"
                            >
                                Delete
                            </button>
                            <button
                                type="button"
                                disabled={!selectedNote}
                                onClick={saveNote}
                                className="rounded-lg bg-cyan-400 px-3 py-2 text-sm font-semibold text-slate-950 transition enabled:hover:bg-cyan-300 disabled:opacity-40"
                            >
                                Save
                            </button>
                        </div>
                    </div>

                    {selectedNote ? (
                        <div className="flex flex-1 flex-col gap-4 p-6">
                            <input
                                value={draftTitle}
                                onChange={(event) => setDraftTitle(event.target.value)}
                                className="bg-white/3 rounded-2xl border border-white/10 px-4 py-3 text-xl font-semibold outline-none transition focus:border-cyan-300"
                            />
                            <textarea
                                value={draftBody}
                                onChange={(event) => setDraftBody(event.target.value)}
                                className="bg-white/3 min-h-0 flex-1 resize-none rounded-2xl border border-white/10 p-4 font-mono text-sm leading-6 text-slate-200 outline-none transition focus:border-cyan-300"
                            />
                        </div>
                    ) : (
                        <div className="flex flex-1 items-center justify-center p-8 text-center text-slate-500">
                            Select a note or create a new one.
                        </div>
                    )}
                </section>

                <section className="flex min-w-0 flex-col">
                    <div className="border-b border-white/10 px-6 py-4">
                        <div className="text-sm text-slate-400">Preview</div>
                        <div className="text-xs text-slate-500">A tiny markdown renderer for the demo.</div>
                    </div>
                    <article className="prose prose-invert max-w-none flex-1 overflow-y-auto p-8">
                        {selectedNote ? renderMarkdown(draftBody) : null}
                    </article>
                </section>
            </main>
        </div>
    );
}
