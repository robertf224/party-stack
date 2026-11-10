import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { replicaStateSource } from "@party-stack/ontology-replica/infrastructure";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect";
import { RpcClient, RpcServer } from "effect/rpc";
import { Worker, type WorkerRunner } from "effect/workers";
import { projectOntologyBackend } from "./authorization.js";
import { replicaServerBackend } from "./composition.js";
import { withInternalCommands } from "./internalAccess.js";
import { ontologyServerDispatch, selectOntology } from "./routing.js";
import {
    makeOntologyProtocolClient,
    ontologyRpcHandlers,
    OntologyRpcs,
    makeOntologyRpcClient,
} from "./rpc.js";
import type { OntologyServer } from "./routing.js";
import type { OntologyRpcServerOptions, OntologyServerClient, OntologyClientOptions } from "./rpc.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";
import type { ReplicaService } from "@party-stack/ontology-replica";
import type { TraceStore } from "@party-stack/runtime/tracing";
import type { WorkerError } from "effect/workers/WorkerError";

/** Supply a platform runner for the worker global or an individual MessagePort.
 * Multiple port servers can share the same source without sharing request scopes.
 */
export const serveOntologyWorker = Effect.fn("OntologyServer.serveWorker")(function* <R>(
    options:
        | OntologyRpcServerOptions<R>
        | OntologyServer<R>
        | Effect.Effect<OntologyServer<R>, unknown, R | Scope.Scope>
): Effect.fn.Return<
    Fiber.Fiber<never, WorkerError>,
    BackendError,
    R | Scope.Scope | WorkerRunner.WorkerRunnerPlatform
> {
    let router: OntologyServer<R> | undefined;
    if (Effect.isEffect(options)) {
        // Start the transport while the native owner is opening. Describe waits
        // for this result, so startup errors arrive as typed RPC failures.
        const ready = yield* Deferred.make<OntologyServer<R>, BackendError>();
        const startup = yield* Scope.fork(yield* Effect.scope);
        yield* options.pipe(
            Effect.mapError((cause) => classifyBackendFailure("worker.open", cause)),
            Scope.provide(startup),
            Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(startup, exit) : Effect.void)),
            Effect.catchDefect((cause) =>
                Effect.fail(
                    new BackendError({
                        operation: "worker.open",
                        kind: "Internal",
                        retryable: false,
                        message: "Ontology server startup failed.",
                        cause,
                    })
                )
            ),
            Effect.tapCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : Effect.logError("Ontology worker startup failed", cause)
            ),
            Effect.matchEffect({
                onFailure: (error) => Deferred.fail(ready, error),
                onSuccess: (server) => Deferred.succeed(ready, server),
            }),
            Effect.forkScoped
        );
        router = {
            _tag: "OntologyServer",
            bind: (...args) => Effect.flatMap(Deferred.await(ready), (server) => server.bind(...args)),
            invalidate: (target) =>
                Effect.flatMap(Deferred.await(ready), (server) => server.invalidate(target)),
            forget: (target) => Effect.flatMap(Deferred.await(ready), (server) => server.forget(target)),
            partitions: Effect.flatMap(Deferred.await(ready), (server) => server.partitions),
            syncOnce: (target) => Effect.flatMap(Deferred.await(ready), (server) => server.syncOnce(target)),
        };
    } else if ("_tag" in options) router = options;
    return yield* RpcServer.make(OntologyRpcs).pipe(
        Effect.provide(
            router
                ? ontologyServerDispatch(router)
                : ontologyRpcHandlers(options as OntologyRpcServerOptions<R>)
        ),
        Effect.provide(RpcServer.layerProtocolWorkerRunner),
        Effect.forkScoped({ startImmediately: true })
    );
});

/** The platform spawner supplies one Worker, SharedWorker or MessagePort.
 * The enclosing scope owns RPC requests, streams and the connection lifetime.
 */
export const makeOntologyWorkerClient = Effect.fn("OntologyClient.worker")(function* (options?: {
    /** Worker transport startup deadline; does not limit ontology/backend initialization. */
    readonly connectionTimeoutMs?: number;
    readonly ontology?: string;
}): Effect.fn.Return<
    OntologyServerClient,
    BackendError,
    Scope.Scope | Worker.WorkerPlatform | Worker.Spawner
> {
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
            const ready = yield* Deferred.make<void, BackendError>();
            const platform = yield* Worker.WorkerPlatform;
            const handshake = Worker.WorkerPlatform.of({
                spawn<O, I>(id: number) {
                    return Effect.map(platform.spawn<O, I>(id), (worker): Worker.Worker<O, I> => ({
                        ...worker,
                        run(handler, settings) {
                            return worker
                                .run(handler, {
                                    onSpawn: Effect.andThen(
                                        settings?.onSpawn ?? Effect.void,
                                        Deferred.succeed(ready, undefined)
                                    ),
                                })
                                .pipe(
                                    Effect.tapCause((cause) =>
                                        Deferred.fail(
                                            ready,
                                            new BackendError({
                                                operation: "worker.connect",
                                                kind: "Unavailable",
                                                retryable: true,
                                                message: "Ontology worker transport failed.",
                                                cause: Cause.squash(cause),
                                            })
                                        )
                                    )
                                );
                        },
                    }));
                },
            });
            // Build in the connection's Scope: providing a scoped transport only to the
            // client constructor would close its worker pool as soon as construction returns.
            const transport = yield* Layer.build(
                // Subscriptions last for a view's lifetime. A finite pool permit count
                // would let them starve commands on this shared port; RPC stream
                // acknowledgements provide flow control for the actual bytes.
                RpcClient.layerProtocolWorker({ size: 1, concurrency: Number.POSITIVE_INFINITY })
            ).pipe(
                Effect.provideService(Worker.WorkerPlatform, handshake),
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
            // The platform's ready message confirms transport startup. Describe
            // can legitimately wait longer for storage, authentication or a backend.
            yield* Deferred.await(ready).pipe(
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
            const rpc = yield* makeOntologyRpcClient.pipe(Effect.provideContext(transport));
            return {
                ontology: Effect.fn("OntologyClient.select")(function* (
                    selected?: string,
                    clientOptions?: OntologyClientOptions
                ) {
                    const name = selected ?? options?.ontology;
                    const client = name === undefined ? rpc : selectOntology(rpc, name);
                    return yield* makeOntologyProtocolClient(client, clientOptions);
                }),
            };
        }),
        connectionScope
    ).pipe(
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(connectionScope, exit) : Effect.void))
    );
});

export interface ServeOpenedOntologyWorkerOptions<R = never> extends Omit<
    OntologyRpcServerOptions<R>,
    "source" | "replica" | "backend" | "traces" | "ready" | "deleteLocalData" | "releaseOwner" | "authorize"
> {
    readonly dangerouslyAllowInternalAccess: true;
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
    if (options.dangerouslyAllowInternalAccess !== true)
        return yield* new BackendError({
            operation: "worker.open",
            kind: "InvalidConfiguration",
            retryable: false,
            message: "A private replica worker requires explicit internal access for its app ports.",
        });
    const ready = yield* Deferred.make<OntologySource, BackendError>();
    const released = yield* Deferred.make<void>();
    let opened: Effect.Success<typeof options.open> | undefined;
    let source: OntologySource | undefined;
    let backend: OntologyBackendService | undefined;
    let view: Effect.Success<ReturnType<typeof projectOntologyBackend>> | undefined;
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
        demand: (subset) => Stream.unwrap(Effect.map(current, (value) => value.demand(subset))),
        subscribeChanges: Effect.flatMap(current, (value) => value.subscribeChanges),
    };
    yield* Effect.forkScoped(
        Effect.gen(function* () {
            opened = yield* options.open;
            source = replicaStateSource(opened.replica);
            if (opened.backend) backend = replicaServerBackend(opened.replica, opened.backend);
            if (opened.replica.ir.policy) {
                if (!backend)
                    return yield* new BackendError({
                        operation: "worker.open",
                        kind: "InvalidConfiguration",
                        retryable: false,
                        message: "A policy-bound worker requires a backend for projected operations.",
                    });
                view = yield* projectOntologyBackend(
                    {
                        backend,
                        ir: opened.replica.ir,
                        context: opened.context ?? opened.replica.context,
                    },
                    "upstream"
                );
                backend = view.backend;
            }
            yield* Deferred.succeed(ready, source);
        }).pipe(
            Scope.provide(startupScope),
            Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(startupScope, exit) : Effect.void)),
            Effect.catchDefect(() =>
                Effect.fail(
                    new BackendError({
                        operation: "worker.open",
                        kind: "Internal",
                        retryable: false,
                        message: "Ontology worker initialization failed.",
                    })
                )
            ),
            Effect.catch((error) => Deferred.fail(ready, error))
        )
    );
    const server = yield* serveOntologyWorker({
        ...options,
        authorize: (request, headers) =>
            Effect.flatMap(current, () =>
                view ? withInternalCommands(view.authorize, true)(request, headers) : Effect.void
            ),
        get source() {
            // Private commands do not make raw replica state safe to project.
            return view ? undefined : proxy;
        },
        get replica() {
            return opened?.replica;
        },
        get backend() {
            return backend;
        },
        get ir() {
            return view?.ir ?? opened?.replica.ir;
        },
        get context() {
            return view?.context ?? opened?.context ?? opened?.replica.context;
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
