import { classifyBackendFailure } from "@party-stack/ontology-backend";
import { BackendError } from "@party-stack/ontology-backend";
import { Effect, Layer } from "effect";
import { HttpEffect } from "effect/http";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import {
    isAttachmentHttpRequest,
    makeAttachmentHttpHandler,
    makeHttpAttachmentClient,
} from "./attachmentHttp.js";
import {
    makeOntologyProtocolClient,
    ontologyRpcHandlers,
    OntologyRpcs,
    makeOntologyRpcClient,
} from "./rpc.js";
import type { OntologyRpcServerOptions, OntologyConnection } from "./rpc.js";
import type { Scope } from "effect";
import type { HttpClient } from "effect/http";

/** Mount the returned Fetch handler at a dedicated route. Its enclosing scope owns
 * the server and active streams; each request still passes mandatory authorization.
 */
export const makeOntologyHttpHandler = Effect.fn("RemoteOntology.httpHandler")(function* <R>(
    options: OntologyRpcServerOptions<R>
): Effect.fn.Return<(request: Request) => Promise<Response>, never, R | Scope.Scope> {
    const app = yield* RpcServer.toHttpEffect(OntologyRpcs).pipe(
        Effect.provide(
            ontologyRpcHandlers({
                ...options,
                authorize: (request, headers) =>
                    request.operation === "CreateAttachment"
                        ? Effect.fail(
                              new BackendError({
                                  operation: "attachment.http",
                                  kind: "NotImplemented",
                                  message: "Use the HTTP binding for streamed uploads.",
                                  retryable: false,
                              })
                          )
                        : options.authorize(request, headers),
            })
        ),
        Effect.provide(RpcSerialization.layerNdjson)
    );
    if (options.backend?.maintenance)
        yield* Effect.forkScoped(
            Effect.forever(
                Effect.sleep(60_000).pipe(
                    Effect.andThen(options.backend.maintenance),
                    Effect.catch((error) =>
                        Effect.logWarning("Ontology maintenance failed", { kind: error.kind })
                    )
                )
            )
        );
    // HttpEffect handles request scopes uninterruptibly by default. Restore interruption
    // while waiting for an RPC response so disconnecting before the first NDJSON chunk
    // closes the request scope and cancels the corresponding server handler.
    const rpcHandler = HttpEffect.toWebHandler(app.pipe(Effect.interruptible));
    const uploadHandler = yield* makeAttachmentHttpHandler(options);
    return (request: Request) =>
        isAttachmentHttpRequest(request) ? uploadHandler(request) : rpcHandler(request);
});

/** Supply an Effect HttpClient with the desired authentication and fetch policy.
 * NDJSON keeps demand and invalidation subscriptions streaming until cancellation.
 */
export const connectOntologyHttp = Effect.fn("RemoteOntology.connectHttp")(function* (options: {
    readonly url: string;
    readonly retryIntervalMs?: number;
}): Effect.fn.Return<OntologyConnection, BackendError, HttpClient.HttpClient | Scope.Scope> {
    const client = yield* makeOntologyRpcClient.pipe(
        Effect.provide(
            RpcClient.layerProtocolHttp({ url: options.url }).pipe(
                Layer.provide(RpcSerialization.layerNdjson)
            )
        )
    );
    const connection = yield* makeOntologyProtocolClient(client, options);
    const uploads = yield* makeHttpAttachmentClient(options.url);
    return {
        ...connection,
        backend: {
            ...connection.backend,
            attachments: {
                ...connection.backend.attachments!,
                stage: (value, bytes) =>
                    Effect.tryPromise({
                        try: async () =>
                            (
                                await uploads.create(bytes, {
                                    id: value.id,
                                    eager: connection.replication.kind === "committed",
                                })
                            ).attachment,
                        catch: (cause) => classifyBackendFailure("remote.attachment", cause),
                    }),
            },
            applyAction: (invocation) =>
                invocation.attachmentUploads?.length
                    ? uploads.applyAction(invocation)
                    : connection.backend.applyAction(invocation),
        },
        operations: {
            ...connection.operations,
            attachments: { ...connection.operations.attachments, create: uploads.create },
        },
    };
});

/** Stateless request/response binding: never opens a replication client session. */
export const connectOntologyBackendHttp = Effect.fn("OntologyBackend.connectHttp")(function* (options: {
    readonly url: string;
}) {
    return (yield* connectOntologyHttp(options)).backend;
});
