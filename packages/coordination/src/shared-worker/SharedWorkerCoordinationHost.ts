import {
    each,
    run,
    suspend,
    until,
    useAbortSignal,
    useScope,
    type Operation,
    type Scope,
    type Task,
} from "effection";
import {
    BaseCoordination,
    type InvocationContext,
} from "../base.js";
import {
    COORDINATION_PROTOCOL_VERSION,
    CoordinationClosedError,
    CoordinationProtocolError,
    CoordinationTransportError,
    type CoordinationCallOptions,
    type CoordinationHost,
    type CoordinationService,
    type CoordinationServiceHandlers,
    type CoordinationServiceServer,
} from "../contracts.js";
import {
    useMessagePort,
} from "../effection/index.js";
import { runInScope } from "../effection/runInScope.js";
import { HostCore } from "../host-core.js";
import {
    deferred,
    normalizeError,
    randomId,
    serializeError,
} from "../internal.js";
import { isRecord } from "../protocol.js";
import type {
    CoordinationMessagePort,
    SharedWorkerCoordinationHostOptions,
} from "./contracts.js";
import type {
    WorkerCancel,
    WorkerDisconnect,
    WorkerEvent,
    WorkerHello,
    WorkerRequest,
    WorkerResponse,
    WorkerWelcome,
} from "./protocol.js";

interface PortConnection {
    readonly port: CoordinationMessagePort;
    readonly active: Map<string, Task<void>>;
    task?: Task<void>;
    scope?: Scope;
    connectionId?: string;
    accepted: boolean;
    disconnected: boolean;
}

export class SharedWorkerCoordinationHost
    extends BaseCoordination
    implements CoordinationHost
{
    readonly role = "host" as const;
    readonly isLeader = true;
    readonly scope: string;

    private readonly nodeId = randomId();
    private readonly connections = new Set<PortConnection>();
    private readonly core: HostCore;
    private readonly rootScope = deferred<Scope>();
    private readonly task: Task<void>;
    private effectionScope: Scope | undefined;
    private closePromise?: Promise<void>;

    constructor(options: SharedWorkerCoordinationHostOptions) {
        super();
        this.scope = options.scope;
        this.core = new HostCore({
            contextClient: (path, signal) =>
                this.createContextClient({ path, signal }),
            publishEvent: (service, event, payload) =>
                this.publishEvent(service, event, payload),
        });
        this.task = run(() => this.useLifetime());
        void this.task.catch((error: unknown) => {
            this.rootScope.reject(
                normalizeError(error)
            );
        });
    }

    connect(port: CoordinationMessagePort): () => void {
        this.assertOpen();
        const connection: PortConnection = {
            port,
            active: new Map<string, Task<void>>(),
            accepted: false,
            disconnected: false,
        };
        this.connections.add(connection);
        const scope = this.effectionScope;
        if (!scope) {
            this.connections.delete(connection);
            throw new CoordinationClosedError();
        }
        connection.task = scope.run(() =>
            this.useConnection(connection)
        );
        void connection.task.catch(
            () => undefined
        );
        return () => {
            void connection.task
                ?.halt()
                .catch(() => undefined);
        };
    }

    serve<Service extends CoordinationService>(
        namespace: string,
        handlers: CoordinationServiceHandlers<Service>
    ): CoordinationServiceServer<Service> {
        this.assertOpen();
        return this.core.serve(namespace, handlers);
    }

    runAsLeader<Result>(
        callback: (context: {
            signal: AbortSignal;
        }) => Result | Promise<Result>,
        options?: CoordinationCallOptions
    ): Promise<Result> {
        try {
            this.assertOpen();
        } catch (error) {
            return Promise.reject(normalizeError(error));
        }
        return this.rootScope.promise
            .then((scope) =>
                runInScope(
                    scope,
                    function* () {
                        const signal =
                            yield* useAbortSignal();
                        return yield* until(
                            Promise.resolve(
                                callback({ signal })
                            )
                        );
                    },
                    [options?.signal]
                )
            )
            .catch((error: unknown) => {
                if (this.closed) {
                    throw new CoordinationClosedError();
                }
                throw normalizeError(error);
            });
    }

    close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closed = true;
        const error = new CoordinationClosedError();
        for (const connection of [...this.connections]) {
            this.post(connection, {
                v: COORDINATION_PROTOCOL_VERSION,
                scope: this.scope,
                type: "disconnect",
                connectionId:
                    connection.connectionId ?? "",
                error: serializeError(error),
            } satisfies WorkerDisconnect);
        }
        this.closePromise = this.task
            .halt()
            .then(() => undefined);
        return this.closePromise;
    }

    protected invokeRequest(
        namespace: string,
        method: string,
        input: unknown,
        options: CoordinationCallOptions | undefined,
        context: InvocationContext
    ): Promise<unknown> {
        if (this.closed) {
            return Promise.reject(new CoordinationClosedError());
        }
        return this.rootScope.promise
            .then((scope) =>
                runInScope(
                    scope,
                    () =>
                        this.invokeOperation(
                            namespace,
                            method,
                            input,
                            context.path
                        ),
                    [
                        context.signal,
                        options?.signal,
                    ]
                )
            )
            .catch((error: unknown) => {
                if (this.closed) {
                    throw new CoordinationClosedError();
                }
                throw normalizeError(error);
            });
    }

    private *invokeOperation(
        namespace: string,
        method: string,
        input: unknown,
        path: readonly string[]
    ): Operation<unknown> {
        const signal = yield* useAbortSignal();
        return yield* until(
            this.core.invoke(
                namespace,
                method,
                input,
                {
                    inheritedSignal: signal,
                    senderId: this.nodeId,
                    path,
                }
            )
        );
    }

    private *useLifetime(): Operation<void> {
        const scope = yield* useScope();
        this.effectionScope = scope;
        this.rootScope.resolve(scope);
        try {
            yield* suspend();
        } finally {
            const error =
                new CoordinationClosedError();
            for (const connection of [
                ...this.connections,
            ]) {
                this.disconnectConnection(
                    connection
                );
            }
            yield* until(this.core.close());
            this.clearEventListeners();
            this.effectionScope = undefined;
            this.rootScope.reject(error);
        }
    }

    private *useConnection(
        connection: PortConnection
    ): Operation<void> {
        connection.scope = yield* useScope();
        try {
            const resource =
                yield* useMessagePort(
                    connection.port
                );
            for (const event of yield* each(resource)) {
                this.onMessage(
                    connection,
                    event.data
                );
                if (connection.disconnected) {
                    return;
                }
                yield* each.next();
            }
        } catch (error) {
            if (
                error instanceof
                    CoordinationTransportError &&
                error.code === "DISCONNECTED"
            ) {
                return;
            }
            throw error;
        } finally {
            connection.scope = undefined;
            this.disconnectConnection(
                connection
            );
        }
    }

    private onMessage(
        connection: PortConnection,
        message: unknown
    ): void {
        if (
            this.closed ||
            connection.disconnected ||
            !isRecord(message)
        ) {
            return;
        }
        if (message.type === "hello") {
            this.onHello(
                connection,
                message as unknown as WorkerHello
            );
            return;
        }
        if (
            !connection.accepted ||
            message.connectionId !== connection.connectionId
        ) {
            return;
        }
        if (
            message.v !== COORDINATION_PROTOCOL_VERSION ||
            message.scope !== this.scope
        ) {
            this.rejectProtocol(connection);
            return;
        }

        if (message.type === "request") {
            this.onRequest(
                connection,
                message as unknown as WorkerRequest
            );
        } else if (message.type === "cancel") {
            const cancel = message as unknown as WorkerCancel;
            void connection.active
                .get(cancel.requestId)
                ?.halt()
                .catch(() => undefined);
        } else if (message.type === "disconnect") {
            this.disconnectConnection(connection);
        }
    }

    private onHello(
        connection: PortConnection,
        hello: WorkerHello
    ): void {
        if (
            typeof hello.connectionId !== "string" ||
            hello.v !== COORDINATION_PROTOCOL_VERSION ||
            hello.scope !== this.scope
        ) {
            const connectionId =
                typeof hello.connectionId === "string"
                    ? hello.connectionId
                    : "";
            this.post(connection, {
                v: COORDINATION_PROTOCOL_VERSION,
                scope: this.scope,
                type: "welcome",
                connectionId,
                accepted: false,
                error: serializeError(
                    new CoordinationProtocolError(
                        "SharedWorker coordination protocol or scope mismatch."
                    )
                ),
            } satisfies WorkerWelcome);
            this.disconnectConnection(connection);
            return;
        }
        if (
            connection.accepted &&
            connection.connectionId !== hello.connectionId
        ) {
            this.disconnectConnection(connection);
            return;
        }
        connection.connectionId = hello.connectionId;
        connection.accepted = true;
        this.post(connection, {
            v: COORDINATION_PROTOCOL_VERSION,
            scope: this.scope,
            type: "welcome",
            connectionId: hello.connectionId,
            accepted: true,
        } satisfies WorkerWelcome);
    }

    private onRequest(
        connection: PortConnection,
        request: WorkerRequest
    ): void {
        if (connection.active.has(request.requestId)) return;
        const scope = connection.scope;
        if (!scope) return;
        const task = scope.run(() =>
            this.handleRequest(connection, request)
        );
        connection.active.set(
            request.requestId,
            task
        );
        void task
            .finally(() => {
                connection.active.delete(
                    request.requestId
                );
            })
            .catch(() => undefined);
    }

    private *handleRequest(
        connection: PortConnection,
        request: WorkerRequest
    ): Operation<void> {
        const signal = yield* useAbortSignal();
        try {
            const result = yield* until(
                this.core.invoke(
                    request.service,
                    request.method,
                    request.payload,
                    {
                        signal,
                        requestId:
                            request.requestId,
                        senderId:
                            request.connectionId,
                        path: [],
                    }
                )
            );
            this.respond(connection, request, {
                ok: true,
                result,
            });
        } catch (error) {
            if (signal.aborted) return;
            this.respond(connection, request, {
                ok: false,
                error: serializeError(error),
            });
        }
    }

    private respond(
        connection: PortConnection,
        request: WorkerRequest,
        outcome:
            | { readonly ok: true; readonly result: unknown }
            | {
                  readonly ok: false;
                  readonly error: ReturnType<
                      typeof serializeError
                  >;
              }
    ): void {
        if (
            connection.disconnected ||
            this.closed ||
            connection.connectionId !== request.connectionId
        ) {
            return;
        }
        this.post(connection, {
            v: COORDINATION_PROTOCOL_VERSION,
            scope: this.scope,
            type: "response",
            connectionId: request.connectionId,
            requestId: request.requestId,
            ...outcome,
        } satisfies WorkerResponse);
    }

    private publishEvent(
        service: string,
        event: string,
        payload: unknown
    ): void {
        this.emitEvent(service, event, payload);
        for (const connection of this.connections) {
            if (
                !connection.accepted ||
                !connection.connectionId
            ) {
                continue;
            }
            this.post(connection, {
                v: COORDINATION_PROTOCOL_VERSION,
                scope: this.scope,
                type: "event",
                connectionId: connection.connectionId,
                service,
                event,
                payload,
            } satisfies WorkerEvent);
        }
    }

    private rejectProtocol(connection: PortConnection): void {
        if (!connection.connectionId) {
            this.disconnectConnection(connection);
            return;
        }
        this.post(connection, {
            v: COORDINATION_PROTOCOL_VERSION,
            scope: this.scope,
            type: "disconnect",
            connectionId: connection.connectionId,
            error: serializeError(
                new CoordinationProtocolError(
                    "SharedWorker coordination protocol or scope mismatch."
                )
            ),
        } satisfies WorkerDisconnect);
        this.disconnectConnection(connection);
    }

    private post(
        connection: PortConnection,
        message:
            | WorkerWelcome
            | WorkerResponse
            | WorkerEvent
            | WorkerDisconnect
    ): void {
        if (connection.disconnected) return;
        try {
            connection.port.postMessage(message);
        } catch {
            this.disconnectConnection(
                connection
            );
        }
    }

    private disconnectConnection(
        connection: PortConnection
    ): void {
        if (connection.disconnected) return;
        connection.disconnected = true;
        this.connections.delete(connection);
        for (const task of connection.active.values()) {
            void task.halt().catch(
                () => undefined
            );
        }
        connection.active.clear();
        connection.port.close?.();
        queueMicrotask(() => {
            void connection.task
                ?.halt()
                .catch(() => undefined);
        });
    }
}
