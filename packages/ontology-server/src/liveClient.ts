import { makeReplicaHost, makeReplicaOntologyView } from "@party-stack/ontology";
import { BackendError } from "@party-stack/ontology-backend";
import { digestBytes } from "@party-stack/ontology-storage/blobs";
import { Runtime } from "@party-stack/runtime";
import { Context, Effect, Exit, Layer, ManagedRuntime, Scope, Stream, Tracer } from "effect";
import type { OntologyConnection } from "./rpc.js";
import type { LiveOntology, LiveOntologyWrites, OntologyIR } from "@party-stack/ontology";

export interface ConnectLiveOntologyOptions<R = never> {
    readonly ir: OntologyIR;
    /** Acquired inside the client's scope so transport streams remain alive until cleanup. */
    readonly connection: Effect.Effect<OntologyConnection, BackendError, R | Scope.Scope>;
    readonly id?: string;
    readonly context?: Record<string, unknown>;
    readonly writes?: LiveOntologyWrites;
    readonly label?: string;
    readonly parent?: { readonly label?: string; readonly location?: string };
}

/** Compose a protocol child and application view over supplied platform services.
 * Each client owns normal local row/blob storage; the parent is its remote provider.
 */
export const connectLiveOntology = Effect.fn("OntologyClient.connect")(function* <R>(
    options: ConnectLiveOntologyOptions<R>
): Effect.fn.Return<LiveOntology, BackendError, R | Runtime | Scope.Scope> {
    const runtime = yield* Runtime;
    const scope = yield* Scope.fork(yield* Effect.scope);
    const open = Effect.gen(function* () {
        const connection = yield* options.connection;
        const definitionHash = connection.definitionHash
            ? yield* digestBytes({
                  type: "application/json",
                  stream: Stream.make(new TextEncoder().encode(JSON.stringify(options.ir))),
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
        if (connection.definitionHash && connection.definitionHash !== definitionHash)
            return yield* new BackendError({
                operation: "ontology.connect",
                kind: "SchemaMismatch",
                message: "Server definition differs from this client.",
                retryable: false,
            });
        const context = options.context ?? {};
        const speculative =
            connection.replication.kind === "speculative" ? connection.replication.source : undefined;
        const { replica, attachments } = yield* makeReplicaHost({
            runtime: runtime.adapter,
            id: options.id,
            ir: options.ir,
            context,
            writes: options.writes,
            backend: connection.backend,
            source: speculative,
        });
        const operations = connection.operations;
        const view = yield* makeReplicaOntologyView({
            ir: options.ir,
            context,
            replica,
            writes: options.writes,
            attachments,
            queryFunction: operations.queryFunction,
            resolveActionParameters: operations.resolveActionParameters,
            decrypt: operations.decrypt,
            traces: runtime.traces,
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
        Effect.provideService(Tracer.Tracer, runtime.traces.tracer),
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void))
    );
});

/** Framework boundary. The ManagedRuntime keeps the supplied platform Layer alive
 * after construction; cleanup closes the client before its platform resources.
 */
export async function createConnectedLiveOntology<E>(
    options: ConnectLiveOntologyOptions & { readonly runtime: Layer.Layer<Runtime, E> }
): Promise<LiveOntology> {
    class Client extends Context.Service<Client, LiveOntology>()("@party-stack/ontology-server/Client") {}
    const app = ManagedRuntime.make(
        Layer.effect(Client, connectLiveOntology(options)).pipe(Layer.provide(options.runtime))
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
