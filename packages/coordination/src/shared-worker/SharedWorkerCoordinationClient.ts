import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import { Effect, Exit, Layer, Scope, Stream } from "effect";
import { RpcClient } from "effect/rpc";
import { RpcClientError } from "effect/rpc/RpcClientError";
import { BaseCoordination, type InvocationContext } from "../base.js";
import {
    COORDINATION_PROTOCOL_VERSION,
    CoordinationClosedError,
    CoordinationTransportError,
    type CoordinationCallOptions,
} from "../contracts.js";
import { deferred, deserializeError, normalizeError, randomId } from "../internal.js";
import { runInEffectScope } from "../resources/runInScope.js";
import { encodeCoordinationValue, decodeCoordinationValue } from "../valueCodec.js";
import { CoordinationRpcs, withStructuredCloneCodec } from "./rpc.js";
import type {
    CoordinationMessagePort,
    SharedWorkerCoordinationClientOptions,
    SharedWorkerSource,
} from "./contracts.js";

const makeClient = () => RpcClient.make(CoordinationRpcs);
type Client = Effect.Success<ReturnType<typeof makeClient>>;

const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class SharedWorkerCoordinationClient extends BaseCoordination {
    readonly role = "client" as const;
    readonly scope: string;

    private readonly connectionId = randomId();
    private readonly ready = deferred<Client>();
    private readonly requestTimeoutMs: number;
    private readonly lifetimeScope = Effect.runSync(Scope.make());
    private terminalError: Error | undefined;
    private closePromise: Promise<void> | undefined;

    constructor(options: SharedWorkerCoordinationClientOptions) {
        super();
        this.scope = options.scope;
        this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        void this.ready.promise.catch(() => undefined);
        void runInEffectScope(this.lifetimeScope, this.useLifetime(options)).catch((error: unknown) =>
            this.fail(normalizeError(error))
        );
    }

    close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closed = true;
        this.ready.reject(new CoordinationClosedError());
        this.clearEventListeners();
        this.closePromise = Effect.runPromise(Scope.close(this.lifetimeScope, Exit.void));
        return this.closePromise;
    }

    protected invokeRequest(
        namespace: string,
        method: string,
        input: unknown,
        options: CoordinationCallOptions | undefined,
        context: InvocationContext
    ): Promise<unknown> {
        if (this.closed) return Promise.reject(new CoordinationClosedError());
        return runInEffectScope(
            this.lifetimeScope,
            Effect.tryPromise({
                try: () => this.ready.promise,
                catch: normalizeError,
            }).pipe(
                Effect.flatMap((client) =>
                    client.Call({
                        ...this.identity(),
                        service: namespace,
                        method,
                        payload: encodeCoordinationValue(input),
                    })
                ),
                Effect.map(decodeCoordinationValue),
                Effect.mapError(decodeRpcError),
                Effect.timeoutOrElse({
                    duration: this.requestTimeoutMs,
                    orElse: () =>
                        Effect.fail(
                            new CoordinationTransportError(
                                `SharedWorker request "${namespace}.${method}" timed out.`,
                                "TIMEOUT"
                            )
                        ),
                })
            ),
            [context.signal, options?.signal]
        ).catch((error: unknown) => {
            if (this.terminalError) throw this.terminalError;
            if (this.closed) throw new CoordinationClosedError();
            throw normalizeError(error);
        });
    }

    private useLifetime = Effect.fnUntraced(function* (
        this: SharedWorkerCoordinationClient,
        options: SharedWorkerCoordinationClientOptions
    ) {
        const port = yield* Effect.try({ try: () => resolvePort(options.worker), catch: normalizeError });
        const disconnected = () =>
            this.fail(
                new CoordinationTransportError("SharedWorker coordination disconnected.", "DISCONNECTED")
            );
        yield* Effect.acquireRelease(
            Effect.sync(() => {
                port.addEventListener("close", disconnected);
                port.addEventListener("messageerror", disconnected);
            }),
            () =>
                Effect.sync(() => {
                    port.removeEventListener("close", disconnected);
                    port.removeEventListener("messageerror", disconnected);
                    port.close?.();
                })
        );
        const transport = Layer.effect(
            RpcClient.Protocol,
            RpcClient.makeProtocolWorker({ size: 1, concurrency: 64 }).pipe(
                Effect.map(withStructuredCloneCodec)
            )
        ).pipe(Layer.provide(BrowserWorker.layer(() => port as MessagePort)));
        yield* Effect.gen(
            function* (this: SharedWorkerCoordinationClient) {
                const client = yield* RpcClient.make(CoordinationRpcs);
                yield* client.Hello(this.identity()).pipe(
                    Effect.mapError(decodeRpcError),
                    Effect.timeoutOrElse({
                        duration: options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
                        orElse: () =>
                            Effect.fail(
                                new CoordinationTransportError(
                                    "SharedWorker coordination handshake timed out.",
                                    "TIMEOUT"
                                )
                            ),
                    }),
                    Effect.tapError((error) =>
                        Effect.sync(() => {
                            // Preserve the rejected handshake before transport finalization closes the port.
                            this.terminalError ??= error;
                            this.ready.reject(error);
                        })
                    )
                );
                yield* client.Events(this.identity()).pipe(
                    Stream.runForEach(({ service, event, payload }) =>
                        Effect.sync(() => this.emitEvent(service, event, decodeCoordinationValue(payload)))
                    ),
                    Effect.mapError(decodeRpcError),
                    Effect.andThen(
                        Effect.fail(
                            new CoordinationTransportError(
                                "SharedWorker coordination disconnected.",
                                "DISCONNECTED"
                            )
                        )
                    ),
                    Effect.catch((error) => Effect.sync(() => this.fail(error))),
                    Effect.onExit(() =>
                        Effect.sync(() =>
                            this.fail(
                                new CoordinationTransportError(
                                    "SharedWorker coordination disconnected.",
                                    "DISCONNECTED"
                                )
                            )
                        )
                    ),
                    Effect.forkScoped({ startImmediately: true })
                );
                this.ready.resolve(client);
                yield* Effect.never;
            }.bind(this)
        ).pipe(Effect.provide(transport));
    });

    private identity() {
        return { version: COORDINATION_PROTOCOL_VERSION, scope: this.scope, connectionId: this.connectionId };
    }

    private fail(error: Error): void {
        if (this.closed) return;
        this.terminalError ??= error;
        this.ready.reject(this.terminalError);
        this.clearEventListeners();
        // Scope closure must run outside the fiber being interrupted.
        void Effect.runPromise(Scope.close(this.lifetimeScope, Exit.void)).catch(() => undefined);
    }
}

function resolvePort(source: SharedWorkerSource): CoordinationMessagePort {
    const value = typeof source === "function" ? source() : source;
    return "port" in value ? value.port : value;
}

function decodeRpcError(
    error:
        | { readonly name: string; readonly message: string; readonly code?: string }
        | RpcClientError
        | Error
): Error {
    if (error instanceof RpcClientError)
        return new CoordinationTransportError(error.message, "TRANSPORT_ERROR", { cause: error });
    return error instanceof Error ? error : deserializeError(error);
}
