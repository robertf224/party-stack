import { BackendError } from "@party-stack/ontology-backend";
import { replicaStateSource } from "@party-stack/ontology-replica/infrastructure";
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { RpcClient, RpcServer } from "effect/rpc";
import { replicaServerBackend } from "./composition.js";
import {
    makeOntologyProtocolClient,
    ontologyRpcHandlers,
    OntologyRpcs,
    makeOntologyRpcClient,
} from "./rpc.js";
import type { OntologyRpcServerOptions, OntologyConnection } from "./rpc.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";
import type { ReplicaService } from "@party-stack/ontology-replica";
import type { TraceStore } from "@party-stack/runtime/tracing";
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
            kind: "InvalidConfiguration",
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
    "source" | "replica" | "backend" | "traces" | "ready" | "deleteLocalData" | "releaseOwner"
> {
    /** Resources acquired here belong to the worker's Scope. */
    readonly open: Effect.Effect<
        {
            readonly replica: ReplicaService;
            readonly backend?: OntologyBackendService;
            readonly context?: Record<string, unknown>;
            readonly traces?: TraceStore;
            readonly deleteLocalData?: Effect.Effect<void, BackendError>;
        },
        BackendError,
        R | Scope.Scope
    >;
}

/** Start serving before restoring private state. Describe waits for readiness and
 * receives typed startup failures. Platform transport/Runtime remain caller supplied.
 */
export const serveOpenedOntologyWorker = Effect.fn("OntologyServer.openWorker")(function* <R>(
    options: ServeOpenedOntologyWorkerOptions<R>
) {
    const ready = yield* Deferred.make<OntologySource, BackendError>();
    const released = yield* Deferred.make<void>();
    let opened: Effect.Success<typeof options.open> | undefined;
    let source: OntologySource | undefined;
    let backend: OntologyBackendService | undefined;
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
        accept: (request) => Effect.flatMap(current, (value) => value.accept!(request)),
        subscribe: (session, view, policy, resume) =>
            Effect.flatMap(current, (value) => value.subscribe!(session, view, policy, resume)),
        acknowledgeDelivery: (position) =>
            Effect.flatMap(current, (value) => value.acknowledgeDelivery!(position)),
        acknowledge: (...args) => Effect.flatMap(current, (value) => value.acknowledge(...args)),
        demand: (subset) => Effect.flatMap(current, (value) => value.demand(subset)),
        subscribeChanges: Effect.flatMap(current, (value) => value.subscribeChanges),
    };
    yield* Effect.forkScoped(
        Effect.gen(function* () {
            opened = yield* options.open;
            source = replicaStateSource(opened.replica);
            if (opened.backend) backend = replicaServerBackend(opened.replica, opened.backend);
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
        get replica() {
            return opened?.replica;
        },
        get backend() {
            return backend;
        },
        get ir() {
            return opened?.replica.ir;
        },
        get context() {
            return opened?.context ?? opened?.replica.context;
        },
        get traces() {
            return opened?.traces;
        },
        ready: Effect.asVoid(current),
        deleteLocalData: Effect.flatMap(
            current,
            () =>
                opened?.deleteLocalData ??
                Effect.fail(
                    new BackendError({
                        operation: "worker.deleteLocalData",
                        kind: "NotImplemented",
                        message: "Local partition deletion is unavailable.",
                        retryable: false,
                    })
                )
        ),
        releaseOwner: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
    });
    yield* Effect.raceFirst(Fiber.join(server), Deferred.await(released));
}, Effect.scoped);
