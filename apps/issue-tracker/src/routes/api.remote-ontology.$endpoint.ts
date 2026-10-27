import { makeStorageOntologyBackend, type OntologyIR } from "@party-stack/ontology";
import { BackendError } from "@party-stack/ontology-backend";
import { makeOntologyServer, projectOntologyBackend } from "@party-stack/ontology-server";
import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import ontology from "../ontology/ontology";
import { auth } from "../server/auth";
import { serverOntology } from "../server/ontology";
import { serverStorage } from "../server/storage";

async function handleRequest(request: Request): Promise<Response> {
    const selected = await auth.api.getSession({
        headers: request.headers,
    });
    if (!selected) {
        return new Response("Authentication required.", {
            status: 401,
            headers: {
                "www-authenticate": 'Session realm="Party Stack Issue Tracker"',
            },
        });
    }
    if (new URL(request.url).pathname.replace(/\/+$/, "").endsWith("/rpc")) {
        return Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const context = { user: selected.user.id };
                    const backend = yield* makeStorageOntologyBackend({
                        ir: serverOntology,
                        namespace: serverStorage.namespace,
                        context,
                        ...serverStorage.native,
                    });
                    yield* backend.maintenance ?? Effect.void;
                    const view = projectOntologyBackend({
                        backend,
                        ir: serverOntology,
                        context,
                        policy: {
                            allowedObjectTypeProperties: Object.fromEntries(
                                ontology.objectTypes.map((type) => [
                                    type.name,
                                    type.properties.map((property) => property.name),
                                ])
                            ),
                            visibleActionTypes: ontology.actionTypes.map((action) => action.name),
                            visibleQueryFunctionTypes: (ontology as OntologyIR).queryFunctionTypes.map(
                                (query) => query.name
                            ),
                            clientContext: "forward",
                            canApplyAction: () => Effect.succeed(true),
                            canRunQueryFunction: () => Effect.succeed(true),
                        },
                    });
                    const { handleRequest } = yield* makeOntologyServer({
                        kind: "proxy",
                        ir: view.ir,
                        backend: {
                            ...view.backend,
                            // Stable logical identity of this ontology, independent of HTTP framing.
                            sourceId: "/api/remote-ontology/",
                            // Request scopes expose finite journal pulls. A persistent host can
                            // additionally expose its shared invalidation stream.
                            changes: view.backend.changes && { pull: view.backend.changes.pull },
                            attachments: backend.attachments,
                        },
                        authorize: (operation) =>
                            [
                                "Describe",
                                "LoadSubset",
                                "PullChanges",
                                "ApplyAction",
                                "ValidateAction",
                                "QueryFunction",
                                "CreateAttachment",
                                "ReadAttachment",
                                "AttachmentMetadata",
                            ].includes(operation.operation)
                                ? Effect.void
                                : Effect.fail(
                                      new BackendError({
                                          operation: "authorize",
                                          kind: "Forbidden",
                                          message: "This operation is not exposed.",
                                          retryable: false,
                                          actionOutcome: "not-committed",
                                      })
                                  ),
                    });
                    const response = yield* Effect.promise(() => handleRequest(request));
                    // This endpoint exposes only finite operations. Keep its acquisition scope
                    // until the RPC body has finished; subscriptions use the long-lived server composition.
                    const body = yield* Effect.promise(() => response.arrayBuffer());
                    return new Response(body, { status: response.status, headers: response.headers });
                })
            )
        );
    }

    return new Response("Not found.", { status: 404 });
}

export const Route = createFileRoute("/api/remote-ontology/$endpoint")({
    server: {
        handlers: {
            POST: ({ request }) => handleRequest(request),
            GET: ({ request }) => handleRequest(request),
        },
    },
});
