import { makeStorageOntologyBackend } from "@party-stack/ontology";
import { makeOntologyServer } from "@party-stack/ontology-server";
import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { HttpEffect, HttpServerResponse } from "effect/http";
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
        return HttpEffect.toWebHandler(
            Effect.gen(function* () {
                const context = { user: selected.user.id };
                const backend = yield* makeStorageOntologyBackend({
                    ir: serverOntology,
                    namespace: serverStorage.namespace,
                    context,
                    ...serverStorage.native,
                });
                yield* backend.maintenance ?? Effect.void;
                const server = yield* makeOntologyServer({ kind: "owned", backend, context });
                const response = yield* Effect.promise(() => server.handleRequest(request));
                return HttpServerResponse.fromWeb(response);
            }).pipe(Effect.interruptible)
        )(request);
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
