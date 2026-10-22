import { mkdirSync } from "node:fs";
import { makeStorageOntologyBackend } from "@party-stack/ontology";
import { BackendError } from "@party-stack/ontology-backend";
import { createRemoteOntologyServer } from "@party-stack/ontology-server/server";
import * as SQLite from "@party-stack/sql-ontology-storage/sqlite";
import { eq, queryOnce, type Collection } from "@tanstack/db";
import { createFileRoute } from "@tanstack/react-router";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { notesOntology } from "../ontology/ontology";
import type { Note, RemoteNotesOntology } from "../ontology/generated/types";

interface NotesContext {
    user: string;
}

mkdirSync("temp", { recursive: true });
const database = new Database("temp/remote-notes.sqlite");
const namespace = "remote-notes-sqlite";

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
    backendAdapter: {
        name: namespace,
        open: (context) =>
            Effect.gen(function* () {
                const storage = yield* SQLite.makeStorage(database, { namespace, mode: "authoritative" });
                return yield* makeStorageOntologyBackend({
                    ir: notesOntology,
                    namespace,
                    context,
                    ...storage,
                });
            }).pipe(
                Effect.mapError((cause) =>
                    cause instanceof BackendError
                        ? cause
                        : new BackendError({
                              operation: "sqlite.open",
                              kind: "Unavailable",
                              message: "SQLite storage failed.",
                              retryable: false,
                              cause,
                          })
                )
            ),
    },
    getContext: (request) => ({
        user: getDemoEmail(request),
    }),
    policy: {
        clientContext: "forward",
        baseObjectTypeQueries: {
            Note: ({ ctx, q, collection }) =>
                q.from({ object: collection }).where(({ object }) => eq(object.ownerEmail, ctx.user)),
            NoteAttachment: ({ ctx, q, collection }) =>
                q.from({ object: collection }).where(({ object }) => eq(object.ownerEmail, ctx.user)),
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
                        email: ctx.user,
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
