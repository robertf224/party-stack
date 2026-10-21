import { BackendError } from "@party-stack/ontology-backend";
import { Effect, Exit, Layer, Scope } from "effect";
import { RpcClient, RpcServer } from "effect/rpc";
import {
    makeOntologyProtocolClient,
    ontologyRpcHandlers,
    OntologyRpcs,
    makeOntologyRpcClient,
} from "./rpc.js";
import type { OntologyRpcServerOptions, OntologyConnection } from "./rpc.js";
import type { Fiber } from "effect";
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
            kind: "Rejected",
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
