import { classifyBackendFailure } from "@party-stack/ontology-backend";
import { BackendError } from "@party-stack/ontology-backend";
import { sliceByteSource } from "@party-stack/ontology-storage/blobs";
import { Effect, Layer, Stream } from "effect";
import { HttpEffect } from "effect/http";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import {
    isAttachmentHttpRequest,
    makeAttachmentHttpHandler,
    makeHttpAttachmentClient,
} from "./attachmentHttp.js";
import { makeOntologyOperationsClient } from "./operations.js";
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
                    Effect.catch(() => Effect.void)
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
        operations: {
            ...connection.operations,
            attachments: { ...connection.operations.attachments, create: uploads.create },
        },
    };
});

/** Stateless request/response binding: never opens a replication client session. */
export const connectOntologyBackendHttp = Effect.fn("OntologyBackend.connectHttp")(function* (options: {
    readonly url: string;
}): Effect.fn.Return<
    import("@party-stack/ontology-backend").OntologyBackendService,
    BackendError,
    HttpClient.HttpClient | Scope.Scope
> {
    const client = yield* makeOntologyRpcClient.pipe(
        Effect.provide(
            RpcClient.layerProtocolHttp({ url: options.url }).pipe(
                Layer.provide(RpcSerialization.layerNdjson)
            )
        )
    );
    const description = yield* client
        .Describe()
        .pipe(Effect.mapError((cause) => classifyBackendFailure("remote.describe", cause)));
    const rpcHelpers = yield* makeOntologyOperationsClient(client);
    const uploads = yield* makeHttpAttachmentClient(options.url);
    const helpers = { ...rpcHelpers, attachments: { ...rpcHelpers.attachments, create: uploads.create } };
    const boundary = <A>(run: (signal: AbortSignal) => Promise<A>) =>
        Effect.tryPromise({ try: run, catch: (cause) => classifyBackendFailure("remote.attachment", cause) });
    return {
        attachments: {
            stage: (value, bytes) =>
                boundary(
                    async () =>
                        (await helpers.attachments.create(bytes, { id: value.id, eager: true })).attachment
                ),
            read: (value, range) =>
                boundary(async () => {
                    const source = await helpers.attachments.source(value);
                    return range ? sliceByteSource(source, range.offset ?? 0, range.length) : source;
                }),
            metadata: (value, settings) =>
                client
                    .AttachmentMetadata({ attachment: value, select: settings?.select })
                    .pipe(
                        Effect.mapError((cause) =>
                            classifyBackendFailure("remote.attachment.metadata", cause)
                        )
                    ),
        },
        encrypted: {
            decrypt: (value) =>
                helpers.decrypt(value).pipe(Effect.map((plaintext) => ({ value: plaintext }))),
        },
        name: "protocol",
        sourceId: description.sourceId,
        supportsIdempotency: description.supportsIdempotency,
        resolveActionParameters: description.actionParameterResolution
            ? helpers.resolveActionParameters
            : undefined,
        changes: description.changes
            ? {
                  pull: (request) =>
                      client
                          .PullChanges(request)
                          .pipe(
                              Effect.mapError((cause) => classifyBackendFailure("remote.pullChanges", cause))
                          ),
                  watch: description.watchChanges
                      ? client.Changes().pipe(
                            Stream.map(() => undefined),
                            Stream.mapError((cause) => classifyBackendFailure("remote.changes", cause))
                        )
                      : undefined,
              }
            : undefined,
        loadSubset: (subset) =>
            client
                .LoadSubset(subset)
                .pipe(Effect.mapError((cause) => classifyBackendFailure("remote.request", cause))),
        applyAction: Effect.fn("OntologyBackend.invokeRemote")(function* (invocation) {
            if (invocation.attachmentUploads?.length) return yield* uploads.applyAction(invocation);
            return yield* client
                .ApplyAction(invocation)
                .pipe(Effect.mapError((cause) => classifyBackendFailure("remote.applyAction", cause)));
        }),
        queryFunction: (name, parameters) =>
            client
                .QueryFunction({ name, parameters })
                .pipe(Effect.mapError((cause) => classifyBackendFailure("remote.request", cause))),
        validateAction: (name, parameters, settings) =>
            client
                .ValidateAction({ name, parameters, knownParameters: settings?.knownParameters })
                .pipe(Effect.mapError((cause) => classifyBackendFailure("remote.request", cause))),
    };
});
