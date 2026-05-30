import { createFileRoute } from "@tanstack/react-router";
import { eq } from "@tanstack/db";
import { createRemoteOntologyServer } from "@party-stack/remote-ontology/server";
import { notesAdapter, notesOntology, userOwnsNote, type NotesContext } from "../ontology/server";
import type { NotesOntologyDefinition } from "../ontology/notesOntology";

function getDemoEmail(request: Request): string {
    const headerEmail = request.headers.get("x-demo-user-email")?.trim();
    return headerEmail && headerEmail.includes("@") ? headerEmail : "ada@example.com";
}

const remoteServer = createRemoteOntologyServer<NotesContext, NotesOntologyDefinition>({
    ir: notesOntology,
    adapter: notesAdapter,
    getContext: (request) => ({
        user: {
            email: getDemoEmail(request),
        },
    }),
    policy: {
        baseObjectTypeQueries: {
            Note: ({ ctx, q, collection }) =>
                q.from({ object: collection }).where(({ object }) => eq(object.ownerEmail, ctx.user.email)),
        },
        allowedObjectTypeProperties: {
            Note: ["id", "ownerEmail", "title", "bodyMarkdown", "createdAt", "updatedAt"],
        },
        canApplyAction: async (ctx, request) => {
            if (request.actionType === "createNote") return true;
            if (request.actionType !== "updateNote" && request.actionType !== "deleteNote") return false;
            return (
                typeof request.parameters.note === "string" &&
                (await userOwnsNote(ctx.user.email, request.parameters.note))
            );
        },
        finalizeActionParameters: (ctx, request) => {
            const now = new Date().toISOString();
            if (request.actionType === "createNote") {
                return {
                    ...request.parameters,
                    ownerEmail: ctx.user.email,
                    createdAt: now,
                    updatedAt: now,
                };
            }
            if (request.actionType === "updateNote") {
                return {
                    ...request.parameters,
                    updatedAt: now,
                };
            }
            return request.parameters;
        },
    },
});

export const Route = createFileRoute("/api/remote-ontology/$endpoint")({
    server: {
        handlers: {
            POST: ({ request }) => remoteServer.handleRequest(request),
        },
    },
});
