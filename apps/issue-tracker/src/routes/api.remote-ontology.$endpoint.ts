import { classifyBackendFailure, unauthenticated } from "@party-stack/ontology-backend";
import { makeOntologyServer, OntologyHttpServer, toWebHandler } from "@party-stack/ontology-server/http";
import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { auth } from "../server/auth";
import { serverStorage } from "../server/storage";

const serverLayer = OntologyHttpServer.layer(
    makeOntologyServer({
        enableRealtime: true,
        kind: "owned",
        backend: serverStorage.backend,
        authenticate: Effect.fn("IssueTracker.authenticate")(function* (request: Request) {
            const session = yield* Effect.tryPromise({
                try: () => auth.api.getSession({ headers: request.headers }),
                catch: (cause) => classifyBackendFailure("authentication", cause),
            });
            if (!session) return yield* unauthenticated();
            return { userId: session.user.id };
        }),
    })
);
const { handler, dispose } = toWebHandler(serverLayer);
if (import.meta.hot) import.meta.hot.dispose(dispose);

const handleRequest = (request: Request) =>
    new URL(request.url).pathname.replace(/\/+$/, "").endsWith("/rpc")
        ? handler(request)
        : new Response("Not found.", { status: 404 });

export const Route = createFileRoute("/api/remote-ontology/$endpoint")({
    server: {
        handlers: {
            POST: ({ request }) => handleRequest(request),
            GET: ({ request }) => handleRequest(request),
        },
    },
});
