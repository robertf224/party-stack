import { mkdirSync } from "node:fs";
import { makeStorageOntologyBackend } from "@party-stack/ontology";
import { BackendError } from "@party-stack/ontology-backend";
import { makeOntologyServer, projectOntologyBackend } from "@party-stack/ontology-server";
import { and, eq, field } from "@party-stack/ontology-storage";
import { byteSource } from "@party-stack/ontology-storage/blobs";
import * as SQLite from "@party-stack/sql-ontology-storage/sqlite";
import { createFileRoute } from "@tanstack/react-router";
import Database from "better-sqlite3";
import { Context, Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { notesOntology } from "../ontology/ontology";

const namespace = "remote-notes-sqlite";
const storage = Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(
        Effect.sync(() => {
            mkdirSync("temp", { recursive: true });
            return new Database("temp/remote-notes.sqlite");
        }),
        (database) => Effect.sync(() => database.close())
    );
    return yield* SQLite.makeStorage(database, { namespace, mode: "authoritative" });
});
// Demo identity selection only. A production app must authenticate this principal.
function user(request: Request) {
    return (
        new URL(request.url).searchParams.get("user")?.trim() ||
        request.headers.get("x-demo-user-email")?.trim() ||
        "ada@example.com"
    );
}
const denied = () =>
    new BackendError({
        operation: "authorize",
        kind: "NotFound",
        message: "Resource not found.",
        retryable: false,
        actionOutcome: "not-committed",
    });

// These three demo principals are bounded; a real server binds authenticated
// principals per request and shares its transfer service within an application scope.
const makePrincipal = Effect.fnUntraced(function* (
    native: Effect.Success<typeof storage>,
    context: { user: string }
) {
    const owned = yield* makeStorageOntologyBackend({
        ir: notesOntology,
        namespace,
        context,
        ...native,
    });
    const canReadAttachment = (id: string) =>
        owned.storage
            .read((tx) =>
                tx.loadSubset("NoteAttachment", {
                    where: and(eq(field("ownerEmail"), context.user), eq(field("attachment", "id"), id)),
                    limit: 1,
                })
            )
            .pipe(Effect.map((rows) => rows.length > 0));
    const attachments = owned.attachments && {
        ...owned.attachments,
        read: (value: Parameters<NonNullable<typeof owned.attachments>["read"]>[0]) =>
            Effect.gen(function* () {
                if (!(yield* canReadAttachment(value.id))) return yield* denied();
                return yield* owned.attachments!.read(value);
            }),
        metadata: (value: Parameters<NonNullable<typeof owned.attachments>["metadata"]>[0]) =>
            Effect.gen(function* () {
                if (!(yield* canReadAttachment(value.id))) return yield* denied();
                return yield* owned.attachments!.metadata(value);
            }),
    };
    const view = projectOntologyBackend({
        backend: owned,
        ir: notesOntology,
        context,
        policy: {
            clientContext: "forward",
            baseObjectTypeQueries: {
                Note: eq(field("ownerEmail"), context.user),
                NoteAttachment: eq(field("ownerEmail"), context.user),
            },
            allowedObjectTypeProperties: Object.fromEntries(
                notesOntology.objectTypes.map((type) => [
                    type.name,
                    type.properties.map((property) => property.name),
                ])
            ),
            canApplyAction: (name, parameters) =>
                name === "createNote"
                    ? Effect.succeed(true)
                    : owned.storage
                          .read((tx) => tx.get("Note", String(parameters.note)))
                          .pipe(Effect.map((note) => note?.ownerEmail === context.user)),
        },
    });
    const { handleRequest: serve } = yield* makeOntologyServer({
        kind: "proxy",
        ir: view.ir,
        backend: {
            ...view.backend,
            sourceId: `/api/remote-ontology/:${context.user}`,
            attachments,
        },
        authorize: (operation) =>
            [
                "Describe",
                "LoadSubset",
                "ApplyAction",
                "ValidateAction",
                "CreateAttachment",
                "ReadAttachment",
                "AttachmentMetadata",
            ].includes(operation.operation)
                ? Effect.void
                : Effect.fail(denied()),
    });
    return { serve, attachments };
});
const acquire = Effect.gen(function* () {
    const native = yield* storage;
    const servers = new Map<string, Effect.Success<ReturnType<typeof makePrincipal>>>();
    for (const email of ["ada@example.com", "grace@example.com", "linus@example.com"])
        servers.set(email, yield* makePrincipal(native, { user: email }));
    return servers;
});
class Persistence extends Context.Service<Persistence, Effect.Success<typeof acquire>>()(
    "remote-notes/Persistence"
) {}
const runtime = ManagedRuntime.make(Layer.effect(Persistence, acquire));
if (import.meta.hot) import.meta.hot.dispose(() => runtime.dispose());

async function handleRequest(request: Request): Promise<Response> {
    const server = (await runtime.runPromise(Persistence)).get(user(request));
    if (!server) return new Response("Not found.", { status: 404 });
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    // Return the stream immediately: uploads send a ready event before chunk calls.
    if (path.endsWith("/rpc")) return server.serve(request);
    if (!path.endsWith("/attachment-content")) return new Response("Not found.", { status: 404 });
    // Stable Markdown content URLs remain a finite read with the same row policy.
    return runtime.runPromise(
        Effect.gen(function* () {
            const input = yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(
                    Schema.Struct({ attachment: Schema.Struct({ id: Schema.NonEmptyString }) })
                )
            )(new URL(request.url).searchParams.get("attachment") ?? "").pipe(
                Effect.mapError(() => denied())
            );
            if (!server.attachments) return yield* denied();
            const content = byteSource(yield* server.attachments.read(input.attachment));
            return new Response(Stream.toReadableStream(content.stream), {
                headers: {
                    "Content-Type": content.type,
                    ...(content.size === undefined ? {} : { "Content-Length": String(content.size) }),
                },
            });
        }).pipe(Effect.catch(() => Effect.succeed(new Response("Not found.", { status: 404 }))))
    );
}
export const Route = createFileRoute("/api/remote-ontology/$endpoint")({
    server: {
        handlers: {
            POST: ({ request }) => handleRequest(request),
            GET: ({ request }) => handleRequest(request),
        },
    },
});
