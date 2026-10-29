import { makeReplicaHost, makeReplicaOntologyView } from "@party-stack/ontology";
import { BackendError } from "@party-stack/ontology-backend";
import { equalValues } from "@party-stack/ontology-spec/query";
import { contextPartition } from "@party-stack/ontology-spec/utils";
import { ontologyDefinitionSignature } from "@party-stack/ontology-storage";
import { digestBytes } from "@party-stack/ontology-storage/blobs";
import { Runtime, RuntimePartition } from "@party-stack/runtime";
import { makeTraceCapture, type TraceRecordingMode } from "@party-stack/runtime/tracing";
import { Context, Effect, Exit, Layer, ManagedRuntime, Scope, Stream, Tracer } from "effect";
import type { OntologyConnection } from "./rpc.js";
import type { LiveOntology, LiveOntologyWrites, OntologyIR } from "@party-stack/ontology";

export interface ConnectLiveOntologyOptions<R = never> {
    /** Defaults to the authenticated server definition returned by Describe. */
    readonly ir?: OntologyIR;
    /** Acquired inside the client's scope so transport streams remain alive until cleanup. */
    readonly connection: Effect.Effect<OntologyConnection, BackendError, R | Scope.Scope>;
    readonly id?: string;
    readonly context?: Record<string, unknown>;
    readonly writes?: LiveOntologyWrites;
    readonly label?: string;
    readonly traceRecording?: TraceRecordingMode;
    readonly parent?: { readonly label?: string; readonly location?: string };
}

/** Compose a protocol child and application view over supplied platform services.
 * Each client owns normal local row/blob storage; the parent is its remote provider.
 */
export const connectLiveOntology = Effect.fn("OntologyClient.connect")(function* <R>(
    options: ConnectLiveOntologyOptions<R>
): Effect.fn.Return<LiveOntology, BackendError, R | Runtime | Scope.Scope> {
    const traces = yield* makeTraceCapture(options.traceRecording);
    const scope = yield* Scope.fork(yield* Effect.scope);
    const open = Effect.gen(function* () {
        const connection = yield* options.connection;
        const ir = options.ir ?? connection.ir;
        if (!ir)
            return yield* new BackendError({
                operation: "ontology.connect",
                kind: "InvalidConfiguration",
                message: "Supply an ontology definition when the server does not describe one.",
                retryable: false,
            });
        const signature = yield* Effect.try({
            try: () => ontologyDefinitionSignature(ir),
            catch: (cause) =>
                new BackendError({
                    operation: "ontology.connect",
                    kind: "InvalidConfiguration",
                    message: "Invalid client ontology definition.",
                    retryable: false,
                    cause,
                }),
        });
        const definitionHash =
            connection.definitionHash && options.ir
                ? yield* digestBytes({
                      type: "application/json",
                      stream: Stream.make(new TextEncoder().encode(signature)),
                  }).pipe(
                      Effect.mapError(
                          (cause) =>
                              new BackendError({
                                  operation: "ontology.connect",
                                  kind: "Internal",
                                  retryable: false,
                                  message: "Could not identify the client definition.",
                                  cause,
                              })
                      )
                  )
                : undefined;
        if (options.ir && connection.definitionHash && connection.definitionHash !== definitionHash)
            return yield* new BackendError({
                operation: "ontology.connect",
                kind: "SchemaMismatch",
                message: "Server definition differs from this client.",
                retryable: false,
            });
        if (connection.context && options.context && !equalValues(connection.context, options.context))
            return yield* new BackendError({
                operation: "ontology.connect",
                kind: "InvalidConfiguration",
                message: "Client context differs from the authenticated server context.",
                retryable: false,
            });
        const context = connection.context ?? options.context ?? {};
        const speculative =
            connection.replication.kind === "speculative" ? connection.replication.source : undefined;
        const { replica, attachments } = yield* makeReplicaHost({
            id: options.id,
            ir,
            context,
            writes: options.writes,
            backend: connection.backend,
            source: speculative,
        });
        const operations = connection.operations;
        const view = yield* makeReplicaOntologyView({
            ir,
            context,
            replica,
            writes: options.writes,
            attachments,
            queryFunction: operations.queryFunction,
            resolveActionParameters: operations.resolveActionParameters,
            decrypt: operations.decrypt,
            traces,
            diagnosticLabel: options.label,
            parentDiagnostics: speculative
                ? {
                      label: options.parent?.label ?? "Parent",
                      role: "host",
                      location: options.parent?.location,
                      replica: operations.replicaMonitor,
                      traces: operations.traces,
                  }
                : undefined,
            parentOutbox: speculative ? operations.outbox : undefined,
            awaitParentAcceptance: Boolean(speculative),
            validate: (name, parameters) => operations.validate(name, parameters),
            validateDraft: (name, parameters, known) => operations.validate(name, parameters, known),
        });
        const captured = yield* Effect.context<never>();
        let closing: Promise<void> | undefined;
        const cleanup = () => (closing ??= Effect.runPromise(Scope.close(scope, Exit.void)));
        return {
            ...view,
            cleanup,
            destroy: async () => {
                try {
                    await Effect.runPromiseWith(captured)(
                        operations.deleteLocalData.pipe(
                            // The parent may close its transport before the stop reply arrives.
                            Effect.andThen(operations.releaseOwner.pipe(Effect.catch(() => Effect.void)))
                        )
                    );
                } finally {
                    await cleanup();
                }
            },
        };
    });
    return yield* Scope.provide(open, scope).pipe(
        (work) => (traces ? work.pipe(Effect.provideService(Tracer.Tracer, traces.tracer)) : work),
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void))
    );
});

/** Framework boundary. The ManagedRuntime keeps the supplied platform Layer alive
 * after construction; cleanup closes the client before its platform resources.
 */
export async function createConnectedLiveOntology<E>(
    options: ConnectLiveOntologyOptions & { readonly runtime: Layer.Layer<Runtime, E, RuntimePartition> }
): Promise<LiveOntology> {
    class Client extends Context.Service<Client, LiveOntology>()("@party-stack/ontology-server/Client") {}
    const app = ManagedRuntime.make(
        Layer.unwrap(
            Effect.gen(function* () {
                // Describe determines the partition, but teardown must still stop
                // the client/transport before closing its platform storage.
                const platformScope = yield* Scope.fork(yield* Effect.scope);
                const connectionScope = yield* Scope.fork(yield* Effect.scope);
                const connection = yield* Scope.provide(options.connection, connectionScope);
                const ir = options.ir ?? connection.ir;
                if (!ir)
                    return yield* new BackendError({
                        operation: "ontology.connect",
                        kind: "InvalidConfiguration",
                        retryable: false,
                        message: "Supply an ontology definition when the server does not describe one.",
                    });
                const context = connection.context ?? options.context ?? {};
                const partition = yield* Effect.try({
                    try: () => ({
                        owner: contextPartition(ir, context),
                        namespace: options.id ?? "connected",
                    }),
                    catch: (cause) =>
                        new BackendError({
                            operation: "runtime.partition",
                            kind: "InvalidConfiguration",
                            retryable: false,
                            message: "Invalid context partition.",
                            cause,
                        }),
                });
                const platform = yield* Layer.buildWithScope(
                    options.runtime.pipe(Layer.provide(Layer.succeed(RuntimePartition)(partition))),
                    platformScope
                );
                return Layer.effect(
                    Client,
                    connectLiveOntology({ ...options, connection: Effect.succeed(connection) }).pipe(
                        Effect.provideContext(platform)
                    )
                );
            })
        )
    );

    try {
        const live = await app.runPromise(Client);
        return {
            ...live,
            cleanup: () => app.dispose(),
            destroy: async () => {
                try {
                    await live.destroy();
                } finally {
                    await app.dispose();
                }
            },
        };
    } catch (cause) {
        await app.dispose();
        throw cause;
    }
}
