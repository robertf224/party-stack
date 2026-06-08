import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { createFileRoute } from "@tanstack/react-router";
import { eq, queryOnce, type Collection } from "@tanstack/db";
import { createSQLiteOntologyAdapter } from "@party-stack/sqlite-ontology";
import { createRemoteOntologyServer } from "@party-stack/remote-ontology/server";
import { notesOntology } from "../ontology/ontology";
import type { Note, RemoteNotesOntology } from "../ontology/generated/types";

interface NotesContext {
    user: {
        email: string;
    };
}

mkdirSync("temp", { recursive: true });

async function userOwnsNote(opts: {
    email: string;
    noteId: string;
    notes: Collection<Note>;
}): Promise<boolean> {
    const note = (await queryOnce((q) =>
        q
            .from({ note: opts.notes })
            .where(({ note }) => eq(note.id, opts.noteId))
            .select(({ note }) => note)
            .findOne()
    )) as unknown as Note | undefined;
    return note?.ownerEmail === opts.email;
}

function getDemoEmail(request: Request): string {
    const queryEmail = new URL(request.url).searchParams.get("user")?.trim();
    if (queryEmail && queryEmail.includes("@")) return queryEmail;
    const headerEmail = request.headers.get("x-demo-user-email")?.trim();
    return headerEmail && headerEmail.includes("@") ? headerEmail : "ada@example.com";
}

const remoteServer = createRemoteOntologyServer<NotesContext, RemoteNotesOntology>({
    ir: notesOntology,
    adapter: createSQLiteOntologyAdapter({
        ir: notesOntology,
        database: new Database("temp/remote-notes.sqlite"),
        name: "remote-notes-sqlite",
    }),
    getContext: (request) => ({
        user: {
            email: getDemoEmail(request),
        },
    }),
    policy: {
        clientContext: "forward",
        baseObjectTypeQueries: {
            Note: ({ ctx, q, collection }) =>
                q.from({ object: collection }).where(({ object }) => eq(object.ownerEmail, ctx.user.email)),
            NoteAttachment: ({ ctx, q, collection }) =>
                q.from({ object: collection }).where(({ object }) => eq(object.ownerEmail, ctx.user.email)),
        },
        allowedObjectTypeProperties: {
            Note: ["id", "ownerEmail", "title", "bodyMarkdown", "createdAt", "updatedAt"],
            NoteAttachment: ["id", "noteId", "ownerEmail", "attachment", "createdAt"],
        },
        canApplyAction: async (ctx, request, { objects }) => {
            switch (request.actionType) {
                case "createNote":
                    return true;
                case "updateNote":
                case "deleteNote":
                case "createNoteAttachment": {
                    const noteId = request.parameters.note;
                    return userOwnsNote({
                        email: ctx.user.email,
                        noteId,
                        notes: objects.Note,
                    });
                }
                default:
                    return false;
            }
        },
    },
});

export const Route = createFileRoute("/api/remote-ontology/$endpoint")({
    server: {
        handlers: {
            POST: ({ request }) => remoteServer.handleRequest(request),
            GET: ({ request }) => remoteServer.handleRequest(request),
        },
    },
});
