import { BackendError } from "@party-stack/ontology-backend";
import { replicaStateSource } from "@party-stack/ontology-replica";
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { RpcClient, RpcServer } from "effect/rpc";
import {
    makeOntologyProtocolClient,
    ontologyRpcHandlers,
    OntologyRpcs,
    makeOntologyRpcClient,
} from "./rpc.js";
import type { OntologyRpcServerOptions, OntologyConnection } from "./rpc.js";
import type { LiveOntology } from "@party-stack/ontology";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";
import type { Worker, WorkerRunner } from "effect/workers";
import type { WorkerError } from "effect/workers/WorkerError";

/** Supply a platform runner for the worker global or an individual MessagePort.
 * Multiple port servers can share the same source without sharing request scopes.
 */
export const serveOntologyWorker = Effect.fn("OntologyServer.serveWorker")(function* <R>(
    options: OntologyRpcServerOptions<R>
): Effect.fn.Return<
    Fiber.Fiber<never, WorkerError>,
    never,
    R | Scope.Scope | WorkerRunner.WorkerRunnerPlatform
> {
    return yield* RpcServer.make(OntologyRpcs).pipe(
        Effect.provide(ontologyRpcHandlers(options)),
        Effect.provide(RpcServer.layerProtocolWorkerRunner),
        Effect.forkScoped({ startImmediately: true })
    );
});

/** The platform spawner supplies one Worker, SharedWorker or MessagePort.
 * The enclosing scope owns RPC requests, streams and the connection lifetime.
 */
export const connectOntologyWorker = Effect.fn("OntologyServer.connectWorker")(function* (options?: {
    readonly retryIntervalMs?: number;
    readonly connectionTimeoutMs?: number;
}): Effect.fn.Return<OntologyConnection, BackendError, Scope.Scope | Worker.WorkerPlatform | Worker.Spawner> {
    const timeout = options?.connectionTimeoutMs ?? 5_000;
    if (!Number.isFinite(timeout) || timeout < 1)
        return yield* new BackendError({
            operation: "worker.connect",
            kind: "ValidationFailed",
            retryable: false,
            message: "Worker connection timeout must be positive.",
        });
    const connectionScope = yield* Scope.fork(yield* Effect.scope);
    return yield* Scope.provide(
        Effect.gen(function* () {
            // Build in the connection's Scope: providing a scoped transport only to the
            // client constructor would close its worker pool as soon as construction returns.
            const transport = yield* Layer.build(
                RpcClient.layerProtocolWorker({ size: 1, concurrency: 64 })
            ).pipe(
                Effect.mapError(
                    (cause) =>
                        new BackendError({
                            operation: "worker.connect",
                            kind: "Unavailable",
                            retryable: true,
                            message: "Ontology worker transport failed.",
                            cause,
                        })
                )
            );
            const client = yield* makeOntologyRpcClient.pipe(Effect.provideContext(transport));
            return yield* makeOntologyProtocolClient(client, options).pipe(
                Effect.timeoutOrElse({
                    duration: timeout,
                    orElse: () =>
                        Effect.fail(
                            new BackendError({
                                operation: "worker.connect",
                                kind: "Unavailable",
                                retryable: true,
                                message: "Ontology worker handshake timed out.",
                            })
                        ),
                })
            );
        }),
        connectionScope
    ).pipe(
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(connectionScope, exit) : Effect.void))
    );
});

export interface ServeOpenedOntologyWorkerOptions<R = never> extends Omit<
    OntologyRpcServerOptions<R>,
    "source" | "ontology" | "backend" | "ready" | "deleteLocalData" | "releaseOwner"
> {
    /** Domain-specific acquisition. The host also releases the returned facade on shutdown. */
    readonly open: Effect.Effect<LiveOntology, BackendError, R | Scope.Scope>;
}

/** Start serving before restoring private state. Describe waits for readiness and
 * receives typed startup failures. Platform transport/Runtime remain caller supplied.
 */
export const serveOpenedOntologyWorker = Effect.fn("OntologyServer.openWorker")(function* <R>(
    options: ServeOpenedOntologyWorkerOptions<R>
) {
    const ready = yield* Deferred.make<OntologySource, BackendError>();
    const released = yield* Deferred.make<void>();
    let ontology: LiveOntology | undefined;
    let source: OntologySource | undefined;
    const current = Deferred.await(ready);
    const startupScope = yield* Scope.fork(yield* Effect.scope);
    const proxy: OntologySource = {
        get sourceId() {
            return source?.sourceId ?? "initializing";
        },
        get supportsIdempotency() {
            return source?.supportsIdempotency ?? false;
        },
        openClient: (resume) => Effect.flatMap(current, (value) => value.openClient(resume)),
        read: (session, view) => Effect.flatMap(current, (value) => value.read(session, view)),
        submit: (request) => Effect.flatMap(current, (value) => value.submit(request)),
        acknowledge: (...args) => Effect.flatMap(current, (value) => value.acknowledge(...args)),
        demand: (subset) => Effect.flatMap(current, (value) => value.demand(subset)),
        subscribeChanges: Effect.flatMap(current, (value) => value.subscribeChanges),
    };
    yield* Effect.forkScoped(
        Effect.gen(function* () {
            const live = yield* Effect.acquireRelease(options.open, (value) =>
                Effect.promise(() => value.cleanup())
            );
            if (!live.storage)
                return yield* new BackendError({
                    operation: "worker.open",
                    kind: "NotImplemented",
                    message: "A worker ontology host requires a replica.",
                    retryable: false,
                });
            ontology = live;
            source = replicaStateSource(live.storage);
            yield* Deferred.succeed(ready, source);
        }).pipe(
            Scope.provide(startupScope),
            Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(startupScope, exit) : Effect.void)),
            Effect.catch((error) => Deferred.fail(ready, error))
        )
    );
    const server = yield* serveOntologyWorker({
        ...options,
        source: proxy,
        get ontology() {
            return ontology;
        },
        ready: Effect.asVoid(current),
        deleteLocalData: Effect.flatMap(current, () =>
            Effect.tryPromise({
                try: () => ontology!.destroy(),
                catch: (cause) =>
                    new BackendError({
                        operation: "worker.deleteLocalData",
                        kind: "Unavailable",
                        retryable: true,
                        message: "Could not delete the local partition.",
                        cause,
                    }),
            })
        ),
        releaseOwner: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
    });
    yield* Effect.raceFirst(Fiber.join(server), Deferred.await(released));
}, Effect.scoped);
