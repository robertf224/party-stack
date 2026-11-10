import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import {
    ClientLeaseSchema,
    ClientSessionSchema,
    ClientTokenSchema,
} from "@party-stack/ontology-backend/clients";
import { DeliveryFrameCodec, DeliveryPositionSchema } from "@party-stack/ontology-backend/delivery";
import { OntologyDescriptionCodec } from "@party-stack/ontology-backend/description";
import {
    CompiledSubsetCodec,
    ClientStateCodec,
    ClientSubmissionCodec,
    ClientViewCodec,
    ObjectSelectionCodec,
} from "@party-stack/ontology-backend/protocol";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { pinOntology } from "@party-stack/ontology-replica";
import {
    ontologyDefinitionSignature,
    ontologyDefinitionContractSignature,
} from "@party-stack/ontology-storage";
import { digestBytes } from "@party-stack/ontology-storage/blobs";
import { Table } from "@party-stack/ontology-storage/tables";
import {
    Cause,
    Context,
    Deferred,
    Effect,
    Exit,
    Layer,
    PubSub,
    Schema,
    Scope,
    Stream,
    SubscriptionRef,
} from "effect";
import { Rpc, RpcClient, RpcGroup, RpcMiddleware, RpcSchema } from "effect/rpc";
import { expectedBindingHeaders, withExpectedBinding } from "./bindingFence.js";
import {
    OntologyErrorProjection,
    errorProjectionLayer,
    projectStateFailures,
    projectActionFailure,
    type ErrorProjectionOptions,
} from "./errorProjection.js";
import {
    OntologyOperationRpcs,
    ontologyOperationHandlers,
    makeOntologyOperationsClient,
    type OntologyOperationRequest,
    type OntologyOperationsClient,
} from "./operations.js";
import { RpcActivity } from "./rpcActivity.js";
import { makeRpcBackend } from "./rpcBackend.js";
import type { AttachmentTransferPolicy } from "./attachmentTransfers.js";
import type { ObjectSelection } from "@party-stack/ontology-backend";
import type { ClientSession, ClientToken } from "@party-stack/ontology-backend/clients";
import type { DeliveryFrame } from "@party-stack/ontology-backend/delivery";
import type { OntologyDescription } from "@party-stack/ontology-backend/description";
import type { ClientSubmission, ClientView, OntologySource } from "@party-stack/ontology-backend/protocol";
import type { CompiledSubset } from "@party-stack/ontology-backend/subset";
import type { ReplicaService, ReplicaPinControls } from "@party-stack/ontology-replica";
import type { TraceStore } from "@party-stack/runtime/tracing";
import type { Headers } from "effect/http/Headers";

const Counter = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const DeliveryStrategy = Schema.Literals(["auto", "snapshot", "incremental"]);
const Description = OntologyDescriptionCodec;
const ReplicaRpcs = RpcGroup.make(
    Rpc.make("Describe", { success: Description, error: BackendError }),
    Rpc.make("SubscribeSelection", {
        payload: { selection: ObjectSelectionCodec, resume: Schema.optional(DeliveryPositionSchema) },
        success: DeliveryFrameCodec,
        error: BackendError,
        stream: true,
    }),
    Rpc.make("SubscribeState", {
        payload: {
            session: ClientSessionSchema,
            view: ClientViewCodec,
            resume: Schema.optional(DeliveryPositionSchema),
        },
        success: DeliveryFrameCodec,
        error: BackendError,
        stream: true,
    }),
    Rpc.make("AckDelivery", {
        payload: { kind: Schema.Literals(["committed", "speculative"]), position: DeliveryPositionSchema },
        error: BackendError,
    }),
    Rpc.make("Accept", { payload: ClientSubmissionCodec, error: BackendError }),
    Rpc.make("OpenClient", {
        payload: { resume: Schema.optional(ClientTokenSchema) },
        success: ClientLeaseSchema,
        error: BackendError,
    }),
    Rpc.make("Read", {
        payload: { session: ClientSessionSchema, view: Schema.optional(ClientViewCodec) },
        success: ClientStateCodec,
        error: BackendError,
    }),
    Rpc.make("Submit", { payload: ClientSubmissionCodec, success: ClientStateCodec, error: BackendError }),
    Rpc.make("Acknowledge", {
        payload: {
            session: ClientSessionSchema,
            revision: Counter,
            through: Counter,
            viewGeneration: Schema.optional(Counter),
        },
        error: BackendError,
    }),
    Rpc.make("Demand", {
        payload: CompiledSubsetCodec,
        success: Schema.Literal("ready"),
        error: BackendError,
        stream: true,
    }),
    Rpc.make("Changes", { success: Schema.Literal("invalidate"), error: BackendError, stream: true })
);

export const OntologyRpcs = ReplicaRpcs.merge(OntologyOperationRpcs).middleware(OntologyErrorProjection);

// Client-only telemetry middleware: classification follows the RPC schema, not
// method-name guesses or elapsed duration. The server wire contract is unchanged.
class SubscriptionTracing extends RpcMiddleware.Service<SubscriptionTracing>()(
    "@party-stack/ontology-server/SubscriptionTracing",
    { requiredForClient: true }
) {}
const subscriptionTracingLayer = RpcMiddleware.layerClient(SubscriptionTracing, ({ rpc, request, next }) =>
    RpcSchema.isStreamSchema(rpc.successSchema)
        ? Effect.annotateCurrentSpan("activity", Context.get(rpc.annotations, RpcActivity)).pipe(
              Effect.andThen(next(request))
          )
        : next(request)
);
export const makeTracedRpcClient = <Rpcs extends Rpc.Any>(group: RpcGroup.RpcGroup<Rpcs>) =>
    RpcClient.make(group.middleware(SubscriptionTracing)).pipe(Effect.provide(subscriptionTracingLayer));

/** The in-process transport keeps the same subscription/transfer trace classification. */
export const makeTracedRpcClientNoSerialization = <Rpcs extends Rpc.Any, E>(
    group: RpcGroup.RpcGroup<Rpcs>,
    options: Parameters<
        typeof RpcClient.makeNoSerialization<Rpc.AddMiddleware<Rpcs, typeof SubscriptionTracing>, E>
    >[1]
) =>
    RpcClient.makeNoSerialization(group.middleware(SubscriptionTracing), options).pipe(
        Effect.provide(subscriptionTracingLayer)
    );

export const makeOntologyRpcClient = makeTracedRpcClient(OntologyRpcs);

export type { OntologyDescription } from "@party-stack/ontology-backend/description";
export interface OntologyClientOptions {
    /** Previously accepted, public source binding; never inferred from cached rows. */
    readonly description?: OntologyDescription;
    /** Validate/adopt definition compatibility after source/context/protocol checks. */
    readonly validate?: (fresh: OntologyDescription) => Effect.Effect<void, BackendError>;
    /** Notification only. Coordinate replacement outside this client scope. */
    readonly onIncompatible?: (error: BackendError) => Effect.Effect<void>;
}
export interface OntologyClientDefinitionStatus {
    readonly status: "retained" | "current" | "incompatible";
    readonly refreshing: boolean;
    readonly error?: BackendError;
}
export interface OntologyClientDefinition {
    readonly get: Effect.Effect<OntologyClientDefinitionStatus>;
    readonly changes: Stream.Stream<OntologyClientDefinitionStatus>;
    /** Explicit, coalesced metadata acquisition. Never required before ordinary operations. */
    readonly refresh: Effect.Effect<OntologyDescription, BackendError>;
}
/** A scoped client of an ontology server, separate from Connect's account connections. */
/** One transport shared by independently scoped, ontology-bound handles. */
export interface OntologyServerClient {
    readonly ontology: (
        name?: string,
        options?: OntologyClientOptions
    ) => Effect.Effect<OntologyClient, BackendError, Scope.Scope>;
}

export interface OntologyClient {
    /** The accepted description used to construct this binding's fixed capabilities. */
    readonly description: OntologyDescription;
    readonly definition: OntologyClientDefinition;
    readonly sourceId: string;
    readonly definitionHash?: string;
    readonly ir?: import("@party-stack/ontology-spec").OntologyIR;
    readonly context?: Record<string, unknown>;
    readonly operations: OntologyOperationsClient;
    /** Pin controls on the selected persistent replica, when the server advertises them. */
    readonly pins?: ReplicaPinControls;
    /** Ordinary ontology operations over the selected replica's download inventory. */
    readonly pinBackend?: Effect.Effect<
        import("@party-stack/ontology-backend").OntologyBackendService,
        BackendError,
        Scope.Scope
    >;
    /** Finite operations are available for all server roles. */
    readonly backend: import("@party-stack/ontology-backend").OntologyBackendService;
    readonly replication:
        | { readonly kind: "committed" }
        | { readonly kind: "speculative"; readonly source: OntologySource };
}

export type OntologyRpcRequest =
    | OntologyOperationRequest
    | { readonly operation: "Describe" | "Changes" }
    | { readonly operation: "OpenClient"; readonly resume?: ClientToken }
    | { readonly operation: "Read"; readonly session: ClientSession; readonly view?: ClientView }
    | { readonly operation: "Submit" | "Accept"; readonly submission: ClientSubmission }
    | {
          readonly operation: "SubscribeSelection";
          readonly selection: ObjectSelection;
      }
    | { readonly operation: "SubscribeState"; readonly session: ClientSession; readonly view: ClientView }
    | {
          readonly operation: "AckDelivery";
          readonly kind: "committed" | "speculative";
          readonly position: import("@party-stack/ontology-backend/delivery").DeliveryPosition;
      }
    | {
          readonly operation: "Acknowledge";
          readonly session: ClientSession;
          readonly revision: number;
          readonly through: number;
          readonly viewGeneration?: number;
      }
    | { readonly operation: "Demand"; readonly subset: CompiledSubset };

/** Bind to an authenticated source/principal partition. Authorization is mandatory:
 * granting domain row access alone does not authorize action parameters or base
 * state inspection. Restricted sources must also project their returned state.
 */
export interface OntologyRpcServerOptions<R = never> extends ErrorProjectionOptions {
    /** Already projected client context. Never use request payloads as trusted context. */
    readonly context?: Record<string, unknown>;
    readonly attachmentTransfers?: AttachmentTransferPolicy<R>;
    /** Opt into downstream watches, change reads and replication sessions. Finite
     * queries/actions and the backend's own upstream lifecycle remain available.
     */
    readonly enableRealtime?: boolean;
    /** Outgoing replication only. Snapshot uses invalidations and finite reads;
     * incremental requires native selected delivery. Auto preserves capability selection.
     */
    readonly deliveryStrategy?: Schema.Schema.Type<typeof DeliveryStrategy>;
    /** Server-controlled selected-delivery capacity, frame and acknowledgment bounds. */
    readonly delivery?: import("@party-stack/ontology-backend/delivery").DeliveryPolicy;
    readonly source?: OntologySource;
    readonly replica?: ReplicaService;
    readonly pins?: ReplicaPinControls;
    readonly traces?: TraceStore;
    readonly backend?: import("@party-stack/ontology-backend").OntologyBackendService;
    /** Worker bootstrap may run while transport starts accepting requests. */
    readonly ready?: Effect.Effect<void, BackendError, R>;
    /** Explicit local-partition administration; omitted helpers cannot delete data or stop an owner. */
    readonly deleteLocalData?: Effect.Effect<void, BackendError, R>;
    readonly releaseOwner?: Effect.Effect<void, BackendError, R>;
    readonly authorize: (
        request: OntologyRpcRequest,
        headers: Headers
    ) => Effect.Effect<void, BackendError, R>;
}

// This gate also rejects direct RPC calls: capability discovery is not enforcement.
const clientSyncOperations: ReadonlySet<OntologyRpcRequest["operation"]> = new Set([
    "WatchSubset",
    "WatchChanges",
    "PullChanges",
    "SubscribeSelection",
    "AckDelivery",
    "SubscribeState",
    "OpenClient",
    "Read",
    "Submit",
    "Accept",
    "Acknowledge",
    "Demand",
    "Changes",
]);

const baseOntologyRpcHandlers = <R>(options: OntologyRpcServerOptions<R>) => {
    const clientSync = options.enableRealtime === true;
    const bindingAuthorization = withExpectedBinding(options);
    const authorize = Effect.fnUntraced(function* (request: OntologyRpcRequest, headers: Headers) {
        yield* bindingAuthorization(request, headers);
        if (!clientSync && clientSyncOperations.has(request.operation))
            return yield* new BackendError({
                operation: request.operation,
                kind: "NotImplemented",
                message: "Client synchronization is disabled on this endpoint.",
                retryable: false,
                actionOutcome: "not-committed",
            });
    });
    const snapshots = options.deliveryStrategy === "snapshot";
    // Snapshot readers must not silently switch to the committed journal path.
    // Its watch stream can still provide ordinary subset invalidation hints.
    const operationOptions = snapshots
        ? {
              ...options,
              get replica() {
                  return options.replica;
              },
              get backend() {
                  const backend = options.backend;
                  if (!backend) return undefined;
                  const watch = backend.changes?.watch;
                  return {
                      ...backend,
                      changes: undefined,
                      watchSubset: backend.watchSubset ?? (watch ? () => watch : undefined),
                  };
              },
          }
        : options;
    const unavailableSource = () =>
        Effect.fail(
            new BackendError({
                operation: "replication",
                kind: "NotImplemented",
                message: "This endpoint serves stateless operations only.",
                retryable: false,
            })
        );
    const unavailableDelivery = () =>
        Effect.fail(
            new BackendError({
                operation: "delivery",
                kind: "NotImplemented",
                message: "Selected incremental delivery is disabled or unavailable on this endpoint.",
                retryable: false,
            })
        );
    const source: OntologySource = options.source ?? {
        sourceId: options.backend?.sourceId ?? "stateless",
        supportsIdempotency: options.backend?.supportsIdempotency ?? false,
        openClient: unavailableSource,
        read: unavailableSource,
        submit: unavailableSource,
        acknowledge: unavailableSource,
        demand: () => Stream.fromEffect(unavailableSource()),
        subscribeChanges: unavailableSource(),
    };
    return ReplicaRpcs.toLayer({
        Describe: (_, context) =>
            authorize({ operation: "Describe" }, context.headers).pipe(
                Effect.andThen(options.ready ?? Effect.void),
                Effect.andThen(
                    Effect.gen(function* () {
                        const strategy = yield* Schema.decodeUnknownEffect(DeliveryStrategy)(
                            options.deliveryStrategy ?? "auto"
                        ).pipe(
                            Effect.mapError(
                                () =>
                                    new BackendError({
                                        operation: "describe",
                                        kind: "InvalidConfiguration",
                                        message: "Invalid delivery strategy.",
                                        retryable: false,
                                    })
                            )
                        );
                        const committedDelivery =
                            clientSync &&
                            Boolean(
                                options.backend?.subscribeSelection && options.backend.acknowledgeDelivery
                            );
                        const speculativeDelivery =
                            clientSync &&
                            Boolean(source.subscribe && source.acknowledgeDelivery && source.accept);
                        if (
                            clientSync &&
                            strategy === "incremental" &&
                            !(options.source ? speculativeDelivery : committedDelivery)
                        )
                            return yield* new BackendError({
                                operation: "describe",
                                kind: "NotImplemented",
                                message: "This source does not support incremental selected delivery.",
                                retryable: false,
                            });
                        const signature = options.ir
                            ? yield* Effect.try({
                                  try: () => ontologyDefinitionSignature(options.ir!),
                                  catch: (cause) =>
                                      new BackendError({
                                          operation: "describe",
                                          kind: "InvalidConfiguration",
                                          message: "Invalid ontology definition.",
                                          retryable: false,
                                          cause,
                                      }),
                              })
                            : undefined;
                        const definitionHash = options.ir
                            ? yield* digestBytes({
                                  type: "application/json",
                                  stream: Stream.make(new TextEncoder().encode(signature!)),
                              }).pipe(Effect.mapError((cause) => classifyBackendFailure("describe", cause)))
                            : undefined;
                        return {
                            version: 1 as const,
                            replication:
                                clientSync && options.source
                                    ? ("speculative" as const)
                                    : ("committed" as const),
                            definitionHash,
                            sourceId: options.source?.sourceId ?? options.backend?.sourceId ?? "stateless",
                            ir: options.ir,
                            context: options.context,
                            supportsIdempotency:
                                options.source?.supportsIdempotency ??
                                options.backend?.supportsIdempotency ??
                                false,
                            delivery: !snapshots && committedDelivery,
                            stateDelivery: Boolean(options.source) && !snapshots && speculativeDelivery,
                            changes: clientSync && Boolean(operationOptions.backend?.changes),
                            watchChanges: clientSync && Boolean(operationOptions.backend?.changes?.watch),
                            watchSubset:
                                clientSync &&
                                Boolean(
                                    operationOptions.backend?.watchSubset ||
                                    options.ir?.objectTypes.some(
                                        (type) =>
                                            typeof operationOptions.backend?.refresh?.(
                                                objectSubset(type.name)
                                            )?.pollIntervalMs === "number"
                                    )
                                ),
                            actionParameterResolution: Boolean(
                                options.backend?.resolveActionParameters || options.replica
                            ),
                            queries: Boolean(options.backend),
                            pins: Boolean(options.pins ?? options.replica),
                            attachments: options.backend
                                ? options.backend.attachments && {
                                      stage: Boolean(options.backend.attachments.stage),
                                  }
                                : options.replica
                                  ? { stage: true }
                                  : undefined,
                            encrypted: Boolean(options.backend ? options.backend.encrypted : options.replica),
                        };
                    })
                )
            ),
        SubscribeSelection: (request, context) =>
            Stream.unwrap(
                Effect.gen(function* () {
                    yield* authorize(
                        { operation: "SubscribeSelection", selection: request.selection },
                        context.headers
                    );
                    if (snapshots || !options.backend?.subscribeSelection)
                        return yield* unavailableDelivery();
                    const delivery = yield* options.backend.subscribeSelection(
                        request.selection,
                        options.delivery,
                        request.resume
                    );
                    return delivery.frames.pipe(
                        Stream.mapEffect((frame) =>
                            Effect.gen(function* () {
                                if (!frame.metadata) return frame;
                                if (frame.metadata.sourceId !== options.backend!.sourceId)
                                    return yield* new BackendError({
                                        operation: "delivery",
                                        kind: "SourceMismatch",
                                        message: "The committed delivery source changed.",
                                        retryable: false,
                                    });
                                // The endpoint binds one logical source/session lifetime. A replica
                                // server's committed facet forwards upstream rows under that identity.
                                return {
                                    ...frame,
                                    metadata: {
                                        ...frame.metadata,
                                        sourceId:
                                            options.source?.sourceId ??
                                            options.backend?.sourceId ??
                                            "stateless",
                                    },
                                };
                            })
                        )
                    );
                })
            ),
        SubscribeState: (request, context) =>
            Stream.unwrap(
                Effect.gen(function* () {
                    yield* authorize({ operation: "SubscribeState", ...request }, context.headers);
                    if (snapshots || !source.subscribe) return yield* unavailableDelivery();
                    const delivery = yield* source.subscribe(
                        request.session,
                        request.view,
                        options.delivery,
                        request.resume
                    );
                    return delivery.frames.pipe(
                        Stream.map((frame) => ({
                            ...frame,
                            changes: frame.changes.map((change) =>
                                change.kind === "put" &&
                                (change.record.kind === "pending" || change.record.kind === "completed")
                                    ? {
                                          ...change,
                                          record: {
                                              ...change.record,
                                              value: projectActionFailure(change.record.value, options),
                                          },
                                      }
                                    : change
                            ),
                        }))
                    );
                })
            ),
        AckDelivery: (request, context) =>
            authorize({ operation: "AckDelivery", ...request }, context.headers).pipe(
                Effect.andThen(() => {
                    if (snapshots) return unavailableDelivery();
                    const ack =
                        request.kind === "committed"
                            ? options.backend?.acknowledgeDelivery
                            : source.acknowledgeDelivery;
                    return ack ? ack(request.position) : unavailableSource();
                })
            ),
        Accept: (request, context) =>
            authorize({ operation: "Accept", submission: request }, context.headers).pipe(
                Effect.andThen(() => (source.accept ? source.accept(request) : unavailableSource()))
            ),
        OpenClient: (request, context) =>
            authorize({ operation: "OpenClient", ...request }, context.headers).pipe(
                Effect.andThen(() => source.openClient(request.resume))
            ),
        Read: (request, context) =>
            authorize({ operation: "Read", ...request }, context.headers).pipe(
                Effect.andThen(() =>
                    source.read(request.session, request.view).pipe(
                        Effect.map((result) => ({
                            ...result,
                            state: projectStateFailures(result.state, options),
                        }))
                    )
                )
            ),
        Submit: (request, context) =>
            authorize({ operation: "Submit", submission: request }, context.headers).pipe(
                Effect.andThen(() =>
                    source.submit(request).pipe(
                        Effect.map((result) => ({
                            ...result,
                            state: projectStateFailures(result.state, options),
                        }))
                    )
                )
            ),
        Acknowledge: (request, context) =>
            authorize({ operation: "Acknowledge", ...request }, context.headers).pipe(
                Effect.andThen(() =>
                    source.acknowledge(
                        request.session,
                        request.revision,
                        request.through,
                        request.viewGeneration
                    )
                )
            ),
        Demand: (subset, context) =>
            Stream.unwrap(
                Effect.gen(function* () {
                    yield* Effect.annotateCurrentSpan("activity", "subscription");
                    yield* authorize({ operation: "Demand", subset }, context.headers);
                    return source.demand(subset).pipe(Stream.as("ready" as const));
                })
            ),
        Changes: (_, context) =>
            Stream.unwrap(
                Effect.gen(function* () {
                    yield* Effect.annotateCurrentSpan("activity", "subscription");
                    yield* authorize({ operation: "Changes" }, context.headers);
                    const changes = options.source ? yield* source.subscribeChanges : undefined;
                    if (!changes) return yield* unavailableSource();
                    // A new stream is a repair boundary, not proof that no updates were missed.
                    return Stream.concat(
                        Stream.make("invalidate" as const),
                        Stream.map(changes, () => "invalidate" as const)
                    );
                })
            ),
    }).pipe(
        Layer.merge(ontologyOperationHandlers(operationOptions, authorize)),
        Layer.merge(errorProjectionLayer(options))
    );
};

const resourceHeader = "x-party-stack-resource";

/** Administrative resources use the same ontology RPCs and transport. Access is
 * still gated by the parent endpoint before the resource is acquired. */
export const ontologyRpcHandlers = <R>(options: OntologyRpcServerOptions<R>) =>
    Layer.unwrap(
        Effect.gen(function* () {
            const scope = yield* Effect.scope;
            const ordinary = yield* Layer.buildWithScope(baseOntologyRpcHandlers(options), scope);
            const pins = yield* Effect.cached(
                Effect.gen(function* () {
                    if (!options.replica)
                        return yield* new BackendError({
                            operation: "pins",
                            kind: "NotImplemented",
                            retryable: false,
                            message: "This endpoint does not own downloads.",
                        });
                    const backend = yield* options.replica.demand.pins.backend;
                    return yield* Layer.buildWithScope(
                        baseOntologyRpcHandlers({
                            backend,
                            ir: pinOntology,
                            context: options.context,
                            enableRealtime: options.enableRealtime,
                            errors: options.errors,
                            authorize: (_, headers) => options.authorize({ operation: "ReadPin" }, headers),
                        }),
                        scope
                    );
                })
            );
            type Rpcs = RpcGroup.Rpcs<typeof OntologyRpcs>;
            type Handler = RpcGroup.HandlersFrom<Rpcs>[Rpcs["_tag"]];
            const handlers = Object.fromEntries(
                [...OntologyRpcs.requests].map(([tag, rpc]) => {
                    const invoke = (payload: never, request: Parameters<Handler>[1]) =>
                        Effect.gen(function* () {
                            const resource = request.headers[resourceHeader];
                            if (resource !== undefined && resource !== "pins")
                                return yield* new BackendError({
                                    operation: "ontology.resource",
                                    kind: "NotFound",
                                    retryable: false,
                                    message: "Unknown ontology resource.",
                                });
                            if (resource === "pins")
                                yield* options.authorize({ operation: "ReadPin" }, request.headers);
                            const context = resource === "pins" ? yield* pins : ordinary;
                            const handler = yield* OntologyRpcs.accessHandler(tag as Rpcs["_tag"]).pipe(
                                Effect.provideContext(context)
                            );
                            return handler(payload, request);
                        });
                    return [
                        tag,
                        RpcSchema.isStreamSchema(rpc.successSchema)
                            ? (payload: never, request: Parameters<Handler>[1]) =>
                                  Stream.unwrap(
                                      invoke(payload, request).pipe(
                                          Effect.map(
                                              (result) => result as Stream.Stream<unknown, BackendError, R>
                                          )
                                      )
                                  )
                            : (payload: never, request: Parameters<Handler>[1]) =>
                                  Effect.flatten(
                                      invoke(payload, request).pipe(
                                          Effect.map(
                                              (result) => result as Effect.Effect<unknown, BackendError, R>
                                          )
                                      )
                                  ),
                    ];
                })
            ) as unknown as {
                readonly [Procedure in Rpcs as Procedure["_tag"]]: Rpc.ToHandlerFn<
                    Procedure,
                    R | Scope.Scope
                >;
            };
            return Layer.merge(OntologyRpcs.toLayer(handlers), errorProjectionLayer(options));
        })
    );

const selectPinResource = (client: OntologyRpcClient): OntologyRpcClient =>
    Object.fromEntries(
        [...OntologyRpcs.requests.keys()].map((tag) => [
            tag,
            (payload: unknown, settings?: { readonly headers?: Record<string, string> }) =>
                Reflect.apply(Reflect.get(client, tag), client, [
                    payload,
                    { ...settings, headers: { ...settings?.headers, [resourceHeader]: "pins" } },
                ]),
        ])
    ) as OntologyRpcClient;

export type OntologyRpcClient = Effect.Success<
    ReturnType<typeof RpcClient.make<RpcGroup.Rpcs<typeof OntologyRpcs>>>
>;
const unavailable = (cause: unknown) => classifyBackendFailure("remote.protocol", cause);
const copyDescription = (description: OntologyDescription) =>
    Effect.try({
        try: () => Schema.decodeUnknownSync(Description)(Schema.encodeSync(Description)(description)),
        catch: (cause) =>
            new BackendError({
                operation: "remote.describe",
                kind: "InvalidResponse",
                retryable: false,
                message: "Invalid ontology description.",
                cause,
            }),
    });

const descriptionValue = Table.make<unknown>({ name: "ontology-description-identity" });
const sameDescriptionValue = (left: unknown, right: unknown) =>
    descriptionValue.encode(left) === descriptionValue.encode(right);
const protocolIdentity = (description: OntologyDescription) => ({
    version: description.version,
    replication: description.replication,
    supportsIdempotency: description.supportsIdempotency,
    delivery: Boolean(description.delivery),
    stateDelivery: Boolean(description.stateDelivery),
    changes: Boolean(description.changes),
    watchChanges: Boolean(description.watchChanges),
    watchSubset: Boolean(description.watchSubset),
    actionParameterResolution: Boolean(description.actionParameterResolution),
    queries: Boolean(description.queries),
    pins: Boolean(description.pins),
    attachments: Boolean(description.attachments),
    stageAttachments: Boolean(description.attachments?.stage),
    encrypted: Boolean(description.encrypted),
});
const checkBootstrapBinding = (accepted: OntologyDescription, fresh: OntologyDescription) =>
    Effect.gen(function* () {
        if (fresh.sourceId !== accepted.sourceId)
            return yield* new BackendError({
                operation: "remote.validate",
                kind: "SourceMismatch",
                retryable: false,
                message: "The ontology source changed.",
            });
        if (!sameDescriptionValue(fresh.context ?? {}, accepted.context ?? {}))
            return yield* new BackendError({
                operation: "remote.validate",
                kind: "SourceMismatch",
                retryable: false,
                message: "The ontology context changed.",
            });
        if (!sameDescriptionValue(protocolIdentity(fresh), protocolIdentity(accepted)))
            return yield* new BackendError({
                operation: "remote.validate",
                kind: "SchemaMismatch",
                retryable: false,
                message: "The ontology protocol capabilities changed.",
            });
    });

const definitionFailure: unique symbol = Symbol("OntologyClient.definitionFailure");
interface InternalDefinition extends OntologyClientDefinition {
    readonly [definitionFailure]: (error: BackendError) => Effect.Effect<void>;
}
/** HTTP byte operations use the same incompatibility notification as typed RPC. */
export const observeOntologyClientFailure = <A, R>(
    client: OntologyClient,
    work: Effect.Effect<A, BackendError, R>
) =>
    work.pipe(
        Effect.tapError(
            (error) =>
                (client.definition as Partial<InternalDefinition>)[definitionFailure]?.(error) ?? Effect.void
        )
    );

const makeDefinitionClient = Effect.fnUntraced(function* (
    raw: OntologyRpcClient,
    description: OntologyDescription,
    options?: OntologyClientOptions
) {
    const scope = yield* Effect.scope;
    const state = yield* SubscriptionRef.make<OntologyClientDefinitionStatus>({
        status: options?.description ? "retained" : "current",
        refreshing: false,
    });
    yield* Effect.addFinalizer(() => PubSub.shutdown(state.pubsub));
    let attempt: Deferred.Deferred<OntologyDescription, BackendError> | undefined;
    const incompatible = (error: BackendError) =>
        error.kind === "SchemaMismatch" || error.kind === "SourceMismatch";
    const notify = (error: BackendError) => options?.onIncompatible?.(error) ?? Effect.void;
    const failed = Effect.fnUntraced(function* (error: BackendError) {
        const previous = yield* SubscriptionRef.get(state);
        yield* SubscriptionRef.set(state, {
            ...previous,
            status: incompatible(error) ? "incompatible" : previous.status,
            refreshing: false,
            error: previous.status === "incompatible" && !incompatible(error) ? previous.error : error,
        });
        if (
            incompatible(error) &&
            (previous.status !== "incompatible" || previous.error?.kind !== error.kind)
        )
            yield* notify(error).pipe(
                Effect.catchCause((cause) =>
                    Effect.logError("Ontology incompatibility callback failed", cause)
                ),
                Effect.forkIn(scope),
                Effect.asVoid
            );
    });
    const validate =
        options?.validate ??
        ((fresh: OntologyDescription) =>
            (!fresh.ir && !description.ir) ||
            (fresh.ir &&
                description.ir &&
                ontologyDefinitionContractSignature(fresh.ir) ===
                    ontologyDefinitionContractSignature(description.ir))
                ? Effect.void
                : Effect.fail(
                      new BackendError({
                          operation: "remote.definition",
                          kind: "SchemaMismatch",
                          retryable: false,
                          message: "The ontology definition changed.",
                      })
                  ));
    const refresh = Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
            if (attempt) return restore(Deferred.await(attempt));
            const pending = Deferred.makeUnsafe<OntologyDescription, BackendError>();
            attempt = pending;
            const check = SubscriptionRef.update(state, (current) => ({ ...current, refreshing: true })).pipe(
                Effect.andThen(
                    raw.Describe().pipe(Effect.mapError(unavailable), Effect.flatMap(copyDescription))
                ),
                Effect.tap((fresh) => checkBootstrapBinding(description, fresh)),
                Effect.tap(validate),
                Effect.tap(() => SubscriptionRef.set(state, { status: "current", refreshing: false })),
                Effect.onExit((exit) =>
                    Effect.gen(function* () {
                        if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
                            const error = Cause.findErrorOption(exit.cause);
                            yield* failed(
                                error._tag === "Some" ? error.value : unavailable(Cause.squash(exit.cause))
                            );
                        }
                        if (attempt === pending) attempt = undefined;
                        yield* Deferred.done(pending, exit);
                    })
                ),
                Effect.catchCause(() => Effect.void)
            );
            return Effect.forkIn(check, scope, { startImmediately: true }).pipe(
                Effect.andThen(restore(Deferred.await(pending)))
            );
        })
    );
    const report = Effect.fnUntraced(function* (error: BackendError) {
        if (!incompatible(error)) return;
        yield* failed(error);
        // Rebinding a source/account needs an explicit acquisition. A metadata
        // refresh must not turn that failure into permission to reset its cache.
        if (error.kind === "SourceMismatch") return;
        yield* refresh.pipe(
            Effect.catchCause(() => Effect.void),
            Effect.forkIn(scope),
            Effect.asVoid
        );
    });
    const headers = expectedBindingHeaders(description);
    // Delivery metadata already carries the contract hash. Check it at the
    // client boundary too, so a receiver's schema failure reaches definition
    // lifecycle handling even when the transport successfully delivered a frame.
    const schemaHash = yield* Effect.cached(
        Effect.suspend(() =>
            description.ir
                ? digestBytes({
                      type: "application/json",
                      stream: Stream.make(
                          new TextEncoder().encode(ontologyDefinitionContractSignature(description.ir))
                      ),
                  })
                : Effect.succeed(undefined)
        ).pipe(Effect.mapError(unavailable))
    );
    const checkFrame = Effect.fnUntraced(function* (frame: DeliveryFrame) {
        if (frame.metadata) {
            if (frame.metadata.sourceId !== description.sourceId)
                return yield* new BackendError({
                    operation: "remote.definition",
                    kind: "SourceMismatch",
                    retryable: false,
                    message: "The delivered ontology source changed.",
                });
            const expected = yield* schemaHash;
            if (expected !== undefined && frame.metadata.schemaHash !== expected)
                return yield* new BackendError({
                    operation: "remote.definition",
                    kind: "SchemaMismatch",
                    retryable: false,
                    message: "The delivered ontology definition changed.",
                });
        }
        return frame;
    });
    const client = Object.fromEntries(
        [...OntologyRpcs.requests].map(([tag, rpc]) => [
            tag,
            (payload: unknown, options?: { readonly headers?: Record<string, string> }) => {
                const invoke = () =>
                    Reflect.apply(Reflect.get(raw, tag), raw, [
                        payload,
                        tag === "Describe"
                            ? options
                            : { ...options, headers: { ...options?.headers, ...headers } },
                    ]);
                if (RpcSchema.isStreamSchema(rpc.successSchema)) {
                    const stream =
                        tag === "SubscribeSelection" || tag === "SubscribeState"
                            ? (invoke() as Stream.Stream<DeliveryFrame, BackendError>).pipe(
                                  Stream.mapEffect(checkFrame)
                              )
                            : (invoke() as Stream.Stream<unknown, BackendError>);
                    return stream.pipe(Stream.tapError(report));
                }
                return (invoke() as Effect.Effect<unknown, BackendError>).pipe(Effect.tapError(report));
            },
        ])
    ) as unknown as OntologyRpcClient;
    const definition: InternalDefinition = {
        get: SubscriptionRef.get(state),
        changes: SubscriptionRef.changes(state),
        refresh,
        [definitionFailure]: report,
    };
    return {
        client,
        definition,
    };
});

/** Use the same source contract with Effect RPC's worker, HTTP or socket transport. */
export const makeOntologyProtocolClient = Effect.fn("RemoteOntology.protocol")(function* (
    client: OntologyRpcClient,
    options?: OntologyClientOptions
): Effect.fn.Return<OntologyClient, BackendError, Scope.Scope> {
    const description = yield* options?.description
        ? copyDescription(options.description)
        : client.Describe().pipe(Effect.mapError(unavailable), Effect.flatMap(copyDescription));
    if (options?.description && !description.ir)
        return yield* new BackendError({
            operation: "remote.bootstrap",
            kind: "InvalidConfiguration",
            retryable: false,
            message: "A retained ontology description must include its definition.",
        });
    const described = yield* makeDefinitionClient(client, description, options);
    const pinBackend = description.pins
        ? makeOntologyProtocolClient(selectPinResource(client)).pipe(
              Effect.map((resource) => resource.backend)
          )
        : undefined;
    client = described.client;
    const operations = yield* makeOntologyOperationsClient(client);
    const common = {
        description,
        definition: described.definition,
        operations,
        pins: description.pins ? operations.pins : undefined,
        pinBackend,
        sourceId: description.sourceId,
        definitionHash: description.definitionHash,
        ir: description.ir,
        context: description.context,
        backend: makeRpcBackend(client, description, operations),
    };
    if (description.replication === "committed") return { ...common, replication: { kind: "committed" } };
    const source: OntologySource = {
        sourceId: description.sourceId,
        outbox: operations.outbox,
        supportsIdempotency: description.supportsIdempotency,
        openClient: (resume) => client.OpenClient({ resume }).pipe(Effect.mapError(unavailable)),
        read: (session, view) => client.Read({ session, view }).pipe(Effect.mapError(unavailable)),
        submit: (request) => client.Submit(request).pipe(Effect.mapError(unavailable)),
        accept: description.stateDelivery
            ? (request) => client.Accept(request).pipe(Effect.mapError(unavailable))
            : undefined,
        subscribe: description.stateDelivery
            ? (session, view, _policy, resume) =>
                  Effect.succeed({
                      frames: client
                          .SubscribeState({ session, view, resume })
                          .pipe(Stream.mapError(unavailable)),
                      acknowledge: (position) =>
                          client
                              .AckDelivery({ kind: "speculative", position })
                              .pipe(Effect.mapError(unavailable)),
                  })
            : undefined,
        acknowledgeDelivery: description.stateDelivery
            ? (position) =>
                  client.AckDelivery({ kind: "speculative", position }).pipe(Effect.mapError(unavailable))
            : undefined,
        acknowledge: (session, revision, through, viewGeneration) =>
            client
                .Acknowledge({ session, revision, through, viewGeneration })
                .pipe(Effect.mapError(unavailable)),
        subscribeChanges: Effect.succeed(
            client.Changes().pipe(
                Stream.map(() => undefined),
                Stream.mapError(unavailable)
            )
        ),
        demand: (subset) => client.Demand(subset).pipe(Stream.as(undefined), Stream.mapError(unavailable)),
    };
    return { ...common, replication: { kind: "speculative", source } };
});

export { errorProjectionLayer } from "./errorProjection.js";
