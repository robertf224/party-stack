import { BackendError } from "@party-stack/ontology-backend";
import {
    ClientLeaseSchema,
    ClientSessionSchema,
    ClientTokenSchema,
} from "@party-stack/ontology-backend/clients";
import {
    BackendSubsetCodec,
    ClientStateCodec,
    ClientSubmissionCodec,
    ClientViewCodec,
} from "@party-stack/ontology-backend/protocol";
import { Deferred, Effect, Schema, Stream, Layer, Scope } from "effect";
import { Rpc, RpcClient, RpcGroup, RpcMiddleware, RpcSchema } from "effect/rpc";
import {
    OntologyOperationRpcs,
    ontologyOperationHandlers,
    makeOntologyOperationsClient,
    type OntologyOperationRequest,
    type OntologyOperationsClient,
} from "./operations.js";
import type { LiveOntology } from "@party-stack/ontology";
import type { BackendSubset } from "@party-stack/ontology-backend";
import type { ClientSession, ClientToken } from "@party-stack/ontology-backend/clients";
import type { ClientSubmission, ClientView, OntologySource } from "@party-stack/ontology-backend/protocol";
import type { Headers } from "effect/http/Headers";

const Counter = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Description = Schema.Struct({
    version: Schema.Literal(1),
    sourceId: Schema.NonEmptyString,
    supportsIdempotency: Schema.Boolean,
});
const ReplicaRpcs = RpcGroup.make(
    Rpc.make("Describe", { success: Description, error: BackendError }),
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
        payload: BackendSubsetCodec,
        success: Schema.Literal("ready"),
        error: BackendError,
        stream: true,
    }),
    Rpc.make("Changes", { success: Schema.Literal("invalidate"), error: BackendError, stream: true })
);

export const OntologyRpcs = ReplicaRpcs.merge(OntologyOperationRpcs);

// Client-only telemetry middleware: classification follows the RPC schema, not
// method-name guesses or elapsed duration. The server wire contract is unchanged.
class SubscriptionTracing extends RpcMiddleware.Service<SubscriptionTracing>()(
    "@party-stack/ontology-server/SubscriptionTracing",
    { requiredForClient: true }
) {}
export const makeOntologyRpcClient = RpcClient.make(OntologyRpcs.middleware(SubscriptionTracing)).pipe(
    Effect.provide(
        RpcMiddleware.layerClient(SubscriptionTracing, ({ rpc, request, next }) =>
            RpcSchema.isStreamSchema(rpc.successSchema)
                ? Effect.annotateCurrentSpan("activity", "subscription").pipe(Effect.andThen(next(request)))
                : next(request)
        )
    )
);

export interface OntologyConnection extends OntologySource {
    readonly operations: OntologyOperationsClient;
}

export type OntologyRpcRequest =
    | OntologyOperationRequest
    | { readonly operation: "Describe" | "Changes" }
    | { readonly operation: "OpenClient"; readonly resume?: ClientToken }
    | { readonly operation: "Read"; readonly session: ClientSession; readonly view?: ClientView }
    | { readonly operation: "Submit"; readonly submission: ClientSubmission }
    | {
          readonly operation: "Acknowledge";
          readonly session: ClientSession;
          readonly revision: number;
          readonly through: number;
          readonly viewGeneration?: number;
      }
    | { readonly operation: "Demand"; readonly subset: BackendSubset };

/** Bind to an authenticated source/principal partition. Authorization is mandatory:
 * granting domain row access alone does not authorize action parameters or base
 * state inspection. Restricted sources must also project their returned state.
 */
export interface OntologyRpcServerOptions<R = never> {
    readonly source: OntologySource;
    readonly ontology?: LiveOntology;
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

export const ontologyRpcHandlers = <R>(options: OntologyRpcServerOptions<R>) => {
    const { source, authorize } = options;
    return ReplicaRpcs.toLayer({
        Describe: (_, context) =>
            authorize({ operation: "Describe" }, context.headers).pipe(
                Effect.andThen(options.ready ?? Effect.void),
                Effect.map(() => ({
                    version: 1 as const,
                    sourceId: source.sourceId,
                    supportsIdempotency: source.supportsIdempotency,
                }))
            ),
        OpenClient: (request, context) =>
            authorize({ operation: "OpenClient", ...request }, context.headers).pipe(
                Effect.andThen(() => source.openClient(request.resume))
            ),
        Read: (request, context) =>
            authorize({ operation: "Read", ...request }, context.headers).pipe(
                Effect.andThen(() => source.read(request.session, request.view))
            ),
        Submit: (request, context) =>
            authorize({ operation: "Submit", submission: request }, context.headers).pipe(
                Effect.andThen(() => source.submit(request))
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
                    yield* source.demand(subset);
                    return Stream.concat(Stream.make("ready" as const), Stream.never);
                })
            ),
        Changes: (_, context) =>
            Stream.unwrap(
                Effect.gen(function* () {
                    yield* Effect.annotateCurrentSpan("activity", "subscription");
                    yield* authorize({ operation: "Changes" }, context.headers);
                    const changes = yield* source.subscribeChanges;
                    // A new stream is a repair boundary, not proof that no updates were missed.
                    return Stream.concat(
                        Stream.make("invalidate" as const),
                        Stream.map(changes, () => "invalidate" as const)
                    );
                })
            ),
    }).pipe(Layer.merge(ontologyOperationHandlers(options)));
};

type ProtocolClient = Effect.Success<ReturnType<typeof RpcClient.make<RpcGroup.Rpcs<typeof OntologyRpcs>>>>;
const unavailable = (cause: unknown) =>
    cause instanceof BackendError
        ? cause
        : new BackendError({
              operation: "remote.protocol",
              kind: "Unavailable",
              message: "Ontology protocol transport failed.",
              retryable: true,
              cause,
          });

/** Use the same source contract with Effect RPC's worker, HTTP or socket transport. */
export const makeOntologyProtocolClient = Effect.fn("RemoteOntology.protocol")(function* (
    client: ProtocolClient,
    options?: { readonly retryIntervalMs?: number }
): Effect.fn.Return<OntologyConnection, BackendError, Scope.Scope> {
    const retryIntervalMs = options?.retryIntervalMs ?? 1_000;
    if (!Number.isFinite(retryIntervalMs) || retryIntervalMs < 1)
        return yield* new BackendError({
            operation: "remote.protocol",
            kind: "Rejected",
            message: "Protocol retry interval must be positive.",
            retryable: false,
        });
    const description = yield* client.Describe().pipe(Effect.mapError(unavailable));
    const operations = yield* makeOntologyOperationsClient(client);
    return {
        operations,
        sourceId: description.sourceId,
        supportsIdempotency: description.supportsIdempotency,
        openClient: (resume) => client.OpenClient({ resume }).pipe(Effect.mapError(unavailable)),
        read: (session, view) => client.Read({ session, view }).pipe(Effect.mapError(unavailable)),
        submit: (request) => client.Submit(request).pipe(Effect.mapError(unavailable)),
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
        demand: (subset) =>
            Effect.gen(function* () {
                const ready = yield* Deferred.make<void, BackendError>();
                yield* Effect.forkScoped(
                    Effect.gen(function* () {
                        let established = false;
                        for (;;) {
                            const result = yield* Effect.result(
                                Stream.runForEach(client.Demand(subset), () =>
                                    Effect.gen(function* () {
                                        established = true;
                                        yield* Deferred.succeed(ready, undefined);
                                    })
                                ).pipe(Effect.mapError(unavailable))
                            );
                            if (!established) {
                                yield* Deferred.fail(
                                    ready,
                                    result._tag === "Failure"
                                        ? result.failure
                                        : unavailable("Demand stream ended before acquisition.")
                                );
                                return;
                            }
                            yield* Effect.sleep(retryIntervalMs);
                        }
                    })
                );
                yield* Deferred.await(ready);
            }),
    };
});
