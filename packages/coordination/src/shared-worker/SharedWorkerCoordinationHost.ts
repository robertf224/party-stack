import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { Effect, Exit, Layer, Queue, Scope, Stream } from "effect";
import { RpcServer } from "effect/rpc";
import { BaseCoordination, type InvocationContext } from "../base.js";
import {
    COORDINATION_PROTOCOL_VERSION,
    CoordinationClosedError,
    CoordinationProtocolError,
    type CoordinationCallOptions,
    type CoordinationHost,
    type CoordinationService,
    type CoordinationServiceHandlers,
    type CoordinationServiceServer,
} from "../contracts.js";
import { HostCore } from "../host-core.js";
import { normalizeError, randomId, serializeError, type SerializedError } from "../internal.js";
import { runInEffectScope } from "../resources/runInScope.js";
import { encodeCoordinationValue, decodeCoordinationValue } from "../valueCodec.js";
import { CoordinationRpcs, withStructuredCloneCodec, type CoordinationRpcEvent } from "./rpc.js";
import type { CoordinationMessagePort, SharedWorkerCoordinationHostOptions } from "./contracts.js";

interface PortConnection {
    readonly scope: Scope.Closeable;
    readonly events: Queue.Queue<CoordinationRpcEvent, SerializedError>;
    connectionId?: string;
    disconnected: boolean;
}

export class SharedWorkerCoordinationHost extends BaseCoordination implements CoordinationHost {
    readonly role = "host" as const;
    readonly isLeader = true;
    readonly scope: string;

    private readonly nodeId = randomId();
    private readonly connections = new Set<PortConnection>();
    private readonly core: HostCore;
    private readonly lifetimeScope = Effect.runSync(Scope.make());
    private closePromise?: Promise<void>;

    constructor(options: SharedWorkerCoordinationHostOptions) {
        super();
        this.scope = options.scope;
        this.core = new HostCore({
            contextClient: (path, signal) => this.createContextClient({ path, signal }),
            publishEvent: (service, event, payload) => this.publishEvent(service, event, payload),
        });
        Effect.runSync(
            Scope.addFinalizer(
                this.lifetimeScope,
                Effect.promise(() => this.core.close())
            )
        );
    }

    connect(port: CoordinationMessagePort): () => void {
        this.assertOpen();
        const connection: PortConnection = {
            scope: Scope.forkUnsafe(this.lifetimeScope),
            events: Effect.runSync(Queue.bounded<CoordinationRpcEvent, SerializedError>(256)),
            disconnected: false,
        };
        this.connections.add(connection);
        const validate = (
            identity: { version: number; scope: string; connectionId: string },
            hello = false
        ) =>
            Effect.try({
                try: () => {
                    if (this.closed || connection.disconnected) throw new CoordinationClosedError();
                    if (
                        identity.version !== COORDINATION_PROTOCOL_VERSION ||
                        identity.scope !== this.scope ||
                        (connection.connectionId !== undefined &&
                            connection.connectionId !== identity.connectionId) ||
                        (!hello && connection.connectionId === undefined)
                    ) {
                        throw new CoordinationProtocolError(
                            "SharedWorker coordination protocol or scope mismatch."
                        );
                    }
                    if (hello) connection.connectionId = identity.connectionId;
                },
                catch: serializeError,
            });
        const handlers = CoordinationRpcs.toLayer({
            Hello: (identity) => validate(identity, true),
            Call: (request, options) =>
                validate(request).pipe(
                    Effect.andThen(
                        Effect.tryPromise({
                            try: (signal) =>
                                this.core.invoke(
                                    request.service,
                                    request.method,
                                    decodeCoordinationValue(request.payload),
                                    {
                                        signal,
                                        requestId: String(options.requestId),
                                        senderId: request.connectionId,
                                        path: [],
                                    }
                                ),
                            catch: serializeError,
                        }).pipe(Effect.map(encodeCoordinationValue))
                    )
                ),
            Events: (identity) =>
                Stream.unwrap(validate(identity).pipe(Effect.as(Stream.fromQueue(connection.events)))),
        });
        // Effect's browser transport only uses the MessagePort methods in our structural contract.
        const transport = Layer.effect(
            RpcServer.Protocol,
            RpcServer.makeProtocolWorkerRunner.pipe(Effect.map(withStructuredCloneCodec))
        ).pipe(Layer.provide(BrowserWorkerRunner.layerMessagePort(port as MessagePort)));
        const disconnected = () => {
            void this.disconnect(connection);
        };
        port.addEventListener("close", disconnected);
        port.addEventListener("messageerror", disconnected);
        Effect.runSync(
            Scope.addFinalizer(
                connection.scope,
                Effect.sync(() => {
                    connection.disconnected = true;
                    this.connections.delete(connection);
                    Queue.shutdownUnsafe(connection.events);
                    port.removeEventListener("close", disconnected);
                    port.removeEventListener("messageerror", disconnected);
                    port.close?.();
                })
            )
        );
        void runInEffectScope(
            connection.scope,
            RpcServer.make(CoordinationRpcs).pipe(Effect.provide(handlers), Effect.provide(transport))
        ).catch(() => this.disconnect(connection));
        return disconnected;
    }

    serve<Service extends CoordinationService>(
        namespace: string,
        handlers: CoordinationServiceHandlers<Service>
    ): CoordinationServiceServer<Service> {
        this.assertOpen();
        return this.core.serve(namespace, handlers);
    }

    runAsLeader<Result>(
        callback: (context: { signal: AbortSignal }) => Result | Promise<Result>,
        options?: CoordinationCallOptions
    ): Promise<Result> {
        if (this.closed) return Promise.reject(new CoordinationClosedError());
        return runInEffectScope(
            this.lifetimeScope,
            Effect.tryPromise({
                try: (signal) => Promise.resolve(callback({ signal })),
                catch: normalizeError,
            }),
            [options?.signal]
        ).catch((error: unknown) => this.rethrowScopedError(error));
    }

    close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closed = true;
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
                try: (signal) =>
                    this.core.invoke(namespace, method, input, {
                        inheritedSignal: signal,
                        senderId: this.nodeId,
                        path: context.path,
                    }),
                catch: normalizeError,
            }),
            [context.signal, options?.signal]
        ).catch((error: unknown) => this.rethrowScopedError(error));
    }

    private publishEvent(service: string, event: string, payload: unknown): void {
        this.emitEvent(service, event, payload);
        for (const connection of this.connections) {
            if (!connection.connectionId || connection.disconnected) continue;
            if (
                !Queue.offerUnsafe(connection.events, {
                    service,
                    event,
                    payload: encodeCoordinationValue(payload),
                })
            ) {
                // Losing an event can lose an action result. Disconnect rather than silently dropping it.
                void this.disconnect(connection);
            }
        }
    }

    private disconnect(connection: PortConnection): Promise<void> {
        connection.disconnected = true;
        return Effect.runPromise(Scope.close(connection.scope, Exit.void));
    }

    private rethrowScopedError(error: unknown): never {
        if (this.closed) throw new CoordinationClosedError();
        throw normalizeError(error);
    }
}
