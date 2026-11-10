import {
    BackendError,
    classifyBackendFailure,
    projectBackendError,
    backendErrorStatus,
} from "@party-stack/ontology-backend";
import { CurrentExecutionContext } from "@party-stack/ontology-backend/policy";
import { Effect, Fiber, Layer, Schema } from "effect";
import {
    HttpClient,
    HttpClientError,
    HttpClientRequest,
    HttpEffect,
    HttpServerRequest,
    HttpServerResponse,
} from "effect/http";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import {
    isAttachmentHttpRequest,
    makeAttachmentHttpHandler,
    makeHttpAttachmentClient,
} from "./attachmentHttp.js";
import { expectedBindingHeaders } from "./bindingFence.js";
import {
    ontologyUrl,
    ontologyHeader,
    selectOntology,
    ontologyServerDispatch,
    OntologyTransportRequest,
    OntologyTransportTarget,
    OntologyTransportBinding,
} from "./routing.js";
import {
    makeOntologyProtocolClient,
    ontologyRpcHandlers,
    OntologyRpcs,
    makeOntologyRpcClient,
    observeOntologyClientFailure,
} from "./rpc.js";
import type { OntologyServer } from "./routing.js";
import type {
    OntologyRpcServerOptions,
    OntologyServerClient,
    OntologyClient,
    OntologyClientOptions,
} from "./rpc.js";
import type { Scope } from "effect";

/** Mount the returned Fetch handler at a dedicated route. Its enclosing scope owns
 * the server and active streams; each request still passes mandatory authorization.
 */
export const makeOntologyHttpHandler = Effect.fn("RemoteOntology.httpHandler")(function* <R>(
    options: OntologyRpcServerOptions<R> | OntologyServer<R>
): Effect.fn.Return<(request: Request) => Promise<Response>, never, R | Scope.Scope> {
    const app = yield* RpcServer.toHttpEffect(OntologyRpcs).pipe(
        Effect.provide(
            "_tag" in options
                ? ontologyServerDispatch(options)
                : ontologyRpcHandlers({
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
    // HttpEffect handles request scopes uninterruptibly by default. Restore interruption
    // while waiting for an RPC response so disconnecting before the first NDJSON chunk
    // closes the request scope and cancels the corresponding server handler.
    if ("_tag" in options) {
        const owner = yield* Effect.scope;
        const routed = Effect.gen(function* () {
            const incoming = yield* HttpServerRequest.HttpServerRequest;
            const request = yield* HttpServerRequest.toWeb(incoming).pipe(
                Effect.mapError(
                    (cause) =>
                        new BackendError({
                            operation: "ontology.http",
                            kind: "InvalidRequest",
                            retryable: false,
                            message: "Invalid HTTP request.",
                            cause,
                        })
                )
            );
            const target =
                new URL(request.url).searchParams.get("ontology") ??
                request.headers.get(ontologyHeader) ??
                options.defaultOntology;
            const bound = target === undefined ? undefined : yield* options.bind(target, request);
            if (isAttachmentHttpRequest(request)) {
                const selected = bound ?? (yield* options.bind(target ?? "", request));
                const upload = yield* makeAttachmentHttpHandler(selected.options);
                return yield* HttpEffect.fromWebHandler(upload).pipe(
                    Effect.provideService(CurrentExecutionContext, selected.executionContext)
                );
            }
            return yield* app.pipe(
                Effect.provideService(OntologyTransportRequest, request),
                Effect.provideService(OntologyTransportTarget, target),
                Effect.provideService(
                    OntologyTransportBinding,
                    bound ? { ontology: target!, bound } : undefined
                )
            );
        }).pipe(
            Effect.catchDefect((cause) =>
                Effect.fail(
                    new BackendError({
                        operation: "ontology.http",
                        kind: "Internal",
                        retryable: false,
                        message: "Ontology request failed.",
                        cause,
                    })
                )
            ),
            Effect.catch((cause) => {
                const error = projectBackendError(
                    classifyBackendFailure("ontology.http", cause),
                    options.errors
                );
                return Effect.succeed(
                    HttpServerResponse.jsonUnsafe(Schema.encodeSync(BackendError)(error), {
                        status: backendErrorStatus(error),
                    })
                );
            }),
            Effect.interruptible
        );
        const captured = yield* Effect.context<R>();
        return HttpEffect.toWebHandlerWith<R, R | Scope.Scope | HttpServerRequest.HttpServerRequest, never>(
            captured
        )(
            Effect.acquireUseRelease(Effect.forkIn(routed, owner), Fiber.join, Fiber.interrupt).pipe(
                Effect.interruptible
            )
        );
    }
    const rpcHandler = HttpEffect.toWebHandler(app.pipe(Effect.interruptible));
    const uploadHandler = yield* makeAttachmentHttpHandler(options);
    return (request: Request) =>
        isAttachmentHttpRequest(request) ? uploadHandler(request) : rpcHandler(request);
});

/** Supply an Effect HttpClient with the desired authentication and fetch policy.
 * NDJSON keeps demand and invalidation subscriptions streaming until cancellation.
 */
export const makeOntologyHttpClient = Effect.fn("OntologyClient.http")(function* (options: {
    readonly url: string;
    readonly ontology?: string;
}): Effect.fn.Return<OntologyServerClient, BackendError, HttpClient.HttpClient | Scope.Scope> {
    // Authentication and infrastructure can reject the HTTP request before any
    // RPC frame exists. Classify its status instead of parsing that body as NDJSON.
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient).pipe(
        HttpClient.catch((error) => {
            const response = error.response;
            if (!response) return Effect.fail(error);
            // A router or authentication hook can fail before there is an RPC
            // frame. Preserve a normal serialized BackendError when present;
            // other hosts' HTML/JSON errors retain ordinary HTTP classification.
            return response.json.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(BackendError)),
                Effect.matchEffect({
                    onFailure: () => Effect.fail(error),
                    onSuccess: (cause) =>
                        Effect.fail(
                            new HttpClientError.HttpClientError({
                                reason: new HttpClientError.StatusCodeError({
                                    request: error.request,
                                    response,
                                    cause,
                                }),
                            })
                        ),
                })
            );
        })
    );
    const url = options.url;
    const rpc = yield* makeOntologyRpcClient.pipe(
        Effect.provide(
            RpcClient.layerProtocolHttp({
                url,
                // Set the complete URL so query parameters remain URL parameters;
                // prependUrl treats its argument as a path segment.
                transformClient: (client) =>
                    HttpClient.mapRequest(client, HttpClientRequest.setUrl(new URL(url))),
            }).pipe(Layer.provide(RpcSerialization.layerNdjson))
        ),
        Effect.provideService(HttpClient.HttpClient, http)
    );
    return {
        ontology: Effect.fn("OntologyClient.select")(
            function* (
                selected?: string,
                clientOptions?: OntologyClientOptions
            ): Effect.fn.Return<OntologyClient, BackendError, HttpClient.HttpClient | Scope.Scope> {
                const name = selected ?? options.ontology;
                const client = yield* makeOntologyProtocolClient(
                    name ? selectOntology(rpc, name) : rpc,
                    clientOptions
                );
                const uploads = yield* makeHttpAttachmentClient(ontologyUrl(url, name)).pipe(
                    Effect.provideService(
                        HttpClient.HttpClient,
                        HttpClient.mapRequest(
                            http,
                            HttpClientRequest.setHeaders(expectedBindingHeaders(client.description))
                        )
                    )
                );
                return {
                    ...client,
                    backend: {
                        ...client.backend,
                        attachments: client.backend.attachments && {
                            ...client.backend.attachments,
                            stage: client.backend.attachments.stage
                                ? (value, bytes) =>
                                      observeOntologyClientFailure(
                                          client,
                                          uploads.create(bytes, {
                                              id: value.id,
                                              eager: client.replication.kind === "committed",
                                          })
                                      ).pipe(Effect.map((created) => created.attachment))
                                : undefined,
                        },
                        applyAction: (invocation) =>
                            invocation.attachmentUploads?.length
                                ? observeOntologyClientFailure(client, uploads.applyAction(invocation))
                                : client.backend.applyAction(invocation),
                    },
                    operations: {
                        ...client.operations,
                        attachments: {
                            ...client.operations.attachments,
                            create: (input, options) =>
                                observeOntologyClientFailure(client, uploads.create(input, options)),
                        },
                    },
                };
            },
            Effect.provideService(HttpClient.HttpClient, http)
        ),
    };
});

/** Stateless request/response binding: never opens a replication client session. */
export const makeOntologyHttpBackend = Effect.fn("OntologyBackend.http")(function* (options: {
    readonly url: string;
    readonly ontology?: string;
}) {
    return (yield* (yield* makeOntologyHttpClient(options)).ontology()).backend;
});
