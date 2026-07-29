import {
    each,
    race,
    run,
    sleep,
    spawn,
    until,
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
} from "../contracts.js";
import {
    useMessagePort,
} from "../effection/index.js";
import { runInScope } from "../effection/runInScope.js";
import {
    deferred,
    deserializeError,
    normalizeError,
    randomId,
    type Deferred,
} from "../internal.js";
import { isRecord } from "../protocol.js";
import type {
    CoordinationMessagePort,
    SharedWorkerCoordinationClientOptions,
    SharedWorkerLike,
    SharedWorkerSource,
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

const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class SharedWorkerCoordinationClient extends BaseCoordination {
    readonly role = "client" as const;
    readonly scope: string;

    private readonly connectionId = randomId();
    private readonly ready = deferred<void>();
    private readonly pending = new Map<
        string,
        Deferred<unknown>
    >();
    private readonly requestTimeoutMs: number;
    private readonly rootScope = deferred<Scope>();
    private readonly task: Task<void>;
    private port: CoordinationMessagePort | undefined;
    private terminalError: Error | undefined;
    private closePromise: Promise<void> | undefined;

    constructor(
        options: SharedWorkerCoordinationClientOptions
    ) {
        super();
        this.scope = options.scope;
        this.requestTimeoutMs =
            options.requestTimeoutMs ??
            DEFAULT_REQUEST_TIMEOUT_MS;
        void this.ready.promise.catch(() => undefined);
        this.task = run(() =>
            this.useLifetime(options)
        );
        void this.task.catch((error: unknown) => {
            this.fail(normalizeError(error));
        });
    }

    close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closed = true;
        try {
            this.send({
                v: COORDINATION_PROTOCOL_VERSION,
                scope: this.scope,
                type: "disconnect",
                connectionId: this.connectionId,
            } satisfies WorkerDisconnect);
        } catch {
            // The peer may already be gone.
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
                        this.requestWhenReady(
                            namespace,
                            method,
                            input
                        ),
                    [
                        context.signal,
                        options?.signal,
                    ]
                )
            )
            .catch((error: unknown) => {
                if (this.terminalError) {
                    throw this.terminalError;
                }
                if (this.closed) {
                    throw new CoordinationClosedError();
                }
                throw normalizeError(error);
            });
    }

    private *requestWhenReady(
        service: string,
        method: string,
        payload: unknown,
    ): Operation<unknown> {
        yield* until(this.ready.promise);
        if (this.terminalError) throw this.terminalError;
        if (this.closed) throw new CoordinationClosedError();

        const requestId = randomId();
        const response = deferred<unknown>();
        this.pending.set(requestId, response);
        const cancel = () => {
            try {
                this.send({
                    v: COORDINATION_PROTOCOL_VERSION,
                    scope: this.scope,
                    type: "cancel",
                    connectionId: this.connectionId,
                    requestId,
                } satisfies WorkerCancel);
            } catch {
                // Cancellation already settles the caller.
            }
        };
        try {
            this.send({
                v: COORDINATION_PROTOCOL_VERSION,
                scope: this.scope,
                type: "request",
                connectionId: this.connectionId,
                requestId,
                service,
                method,
                payload,
            } satisfies WorkerRequest);
            return yield* this.waitForResponse(
                response.promise,
                service,
                method,
            );
        } finally {
            if (!response.settled) cancel();
            if (this.pending.get(requestId) === response) {
                this.pending.delete(requestId);
            }
        }
    }

    private *waitForResponse(
        response: Promise<unknown>,
        service: string,
        method: string,
    ): Operation<unknown> {
        const timeout = this.requestTimeoutMs;
        const result = yield* race([
            (function* () {
                return {
                    type: "response" as const,
                    value: yield* until(response),
                };
            })(),
            (function* () {
                yield* sleep(timeout);
                return {
                    type: "timeout" as const,
                };
            })(),
        ]);
        if (result.type === "timeout") {
            throw new CoordinationTransportError(
                `SharedWorker request "${service}.${method}" timed out.`,
                "TIMEOUT"
            );
        }
        return result.value;
    }

    private *useLifetime(
        options: SharedWorkerCoordinationClientOptions
    ): Operation<void> {
        const scope = yield* useScope();
        this.rootScope.resolve(scope);
        const port = resolvePort(options.worker);
        this.port = port;
        try {
            const resource =
                yield* useMessagePort(port);
            this.send({
                v: COORDINATION_PROTOCOL_VERSION,
                scope: this.scope,
                type: "hello",
                connectionId: this.connectionId,
            } satisfies WorkerHello);
            void (yield* spawn(() =>
                this.waitForHandshake(
                    options.connectionTimeoutMs ??
                        DEFAULT_CONNECTION_TIMEOUT_MS
                )
            ));
            for (const event of yield* each(resource)) {
                this.onMessage(event.data);
                yield* each.next();
            }
            throw new CoordinationTransportError(
                "SharedWorker coordination disconnected.",
                "DISCONNECTED"
            );
        } catch (error) {
            this.terminalError ??=
                normalizeError(error);
            throw error;
        } finally {
            const error =
                this.terminalError ??
                new CoordinationClosedError();
            this.ready.reject(error);
            this.rejectPending(error);
            this.clearEventListeners();
            this.rootScope.reject(error);
            this.port = undefined;
        }
    }

    private *waitForHandshake(
        timeout: number
    ): Operation<void> {
        const ready = this.ready.promise;
        const result = yield* race([
            (function* () {
                yield* until(ready);
                return "ready" as const;
            })(),
            (function* () {
                yield* sleep(timeout);
                return "timeout" as const;
            })(),
        ]);
        if (result === "timeout") {
            throw new CoordinationTransportError(
                "SharedWorker coordination handshake timed out.",
                "TIMEOUT"
            );
        }
    }

    private onMessage(message: unknown): void {
        if (
            this.closed ||
            !isRecord(message) ||
            message.connectionId !== this.connectionId
        ) {
            return;
        }
        const type = message.type;
        if (type === "welcome") {
            this.onWelcome(
                message as unknown as WorkerWelcome
            );
            return;
        }
        if (
            message.v !== COORDINATION_PROTOCOL_VERSION ||
            message.scope !== this.scope
        ) {
            this.fail(
                new CoordinationProtocolError(
                    "SharedWorker coordination protocol or scope mismatch."
                )
            );
            return;
        }
        if (type === "response") {
            const response =
                message as unknown as WorkerResponse;
            const pending = this.pending.get(
                response.requestId
            );
            if (!pending) return;
            if (response.ok) {
                pending.resolve(response.result);
            } else {
                pending.reject(
                    response.error
                        ? deserializeError(response.error)
                        : new CoordinationTransportError(
                              "SharedWorker returned an invalid error response.",
                              "TRANSPORT_ERROR"
                          )
                );
            }
        } else if (type === "event") {
            const event = message as unknown as WorkerEvent;
            this.emitEvent(
                event.service,
                event.event,
                event.payload
            );
        } else if (type === "disconnect") {
            const disconnect =
                message as unknown as WorkerDisconnect;
            this.fail(
                disconnect.error
                    ? deserializeError(disconnect.error)
                    : new CoordinationTransportError(
                          "SharedWorker coordination disconnected.",
                          "DISCONNECTED"
                      )
            );
        }
    }

    private onWelcome(message: WorkerWelcome): void {
        if (
            message.v !== COORDINATION_PROTOCOL_VERSION ||
            message.scope !== this.scope
        ) {
            this.fail(
                new CoordinationProtocolError(
                    "SharedWorker coordination protocol or scope mismatch."
                )
            );
            return;
        }
        if (!message.accepted) {
            this.fail(
                message.error
                    ? deserializeError(message.error)
                    : new CoordinationProtocolError(
                          "SharedWorker rejected the coordination connection."
                      )
            );
            return;
        }
        this.ready.resolve(undefined);
    }

    private send(
        message:
            | WorkerHello
            | WorkerRequest
            | WorkerCancel
            | WorkerDisconnect
    ): void {
        if (this.terminalError) throw this.terminalError;
        if (!this.port) {
            throw new CoordinationTransportError(
                "SharedWorker coordination did not create a message port.",
                "TRANSPORT_ERROR"
            );
        }
        try {
            this.port.postMessage(message);
        } catch (error) {
            throw new CoordinationTransportError(
                "Failed to send a SharedWorker coordination message.",
                "TRANSPORT_ERROR",
                { cause: error }
            );
        }
    }

    private fail(error: Error): void {
        if (this.terminalError || this.closed) return;
        this.terminalError = error;
        this.ready.reject(error);
        this.rejectPending(error);
        void this.task.halt().catch(
            () => undefined
        );
    }

    private rejectPending(error: Error): void {
        for (const pending of this.pending.values()) {
            pending.reject(error);
        }
        this.pending.clear();
    }

}

function resolvePort(
    source: SharedWorkerSource
): CoordinationMessagePort {
    const value = typeof source === "function" ? source() : source;
    return isWorkerLike(value) ? value.port : value;
}

function isWorkerLike(
    value: CoordinationMessagePort | SharedWorkerLike
): value is SharedWorkerLike {
    return "port" in value;
}
