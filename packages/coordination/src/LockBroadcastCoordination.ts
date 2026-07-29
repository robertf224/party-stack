import {
    each,
    race,
    run,
    sleep,
    spawn,
    suspend,
    until,
    useAbortSignal,
    useScope,
    type Operation,
    type Scope,
    type Stream,
    type Task,
} from "effection";
import {
    BaseCoordination,
    type InvocationContext,
} from "./base.js";
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
    type LockBroadcastCoordinationOptions,
} from "./contracts.js";
import {
    useBroadcastChannel,
    useWebLock,
    type BroadcastChannelResource,
} from "./effection/index.js";
import { runInScope } from "./effection/runInScope.js";
import { HostCore } from "./host-core.js";
import {
    abortError,
    deferred,
    deserializeError,
    linkAbortSignal,
    normalizeError,
    randomId,
    serializeError,
    waitForAbortable,
    type Deferred,
} from "./internal.js";
import {
    isRecord,
    messageType,
    type CoordinationCancelMessage,
    type CoordinationEventMessage,
    type CoordinationRequestMessage,
    type CoordinationResponseMessage,
} from "./protocol.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_REQUEST_ATTEMPTS = 3;
const DEFAULT_RESPONSE_CACHE_MS = 30_000;
const MAX_RESPONSE_CACHE_SIZE = 1_000;

interface CachedResponse {
    readonly response: CoordinationResponseMessage;
    readonly expiresAt: number;
}

interface IncomingRequest {
    readonly controller: AbortController;
    readonly term: LeadershipTerm;
    readonly completion: Promise<void>;
}

interface LeadershipTerm {
    readonly scope: Scope;
    readonly signal: AbortSignal;
}

export class LockBroadcastCoordination
    extends BaseCoordination
    implements CoordinationHost
{
    readonly role = "host" as const;
    readonly scope: string;

    private readonly nodeId = randomId();
    private readonly requestTimeoutMs: number;
    private readonly requestAttempts: number;
    private readonly responseCacheMs: number;
    private readonly core: HostCore;
    private readonly ready = deferred<void>();
    private readonly rootScope = deferred<Scope>();
    private readonly pending = new Map<
        string,
        Deferred<unknown>
    >();
    private readonly incoming = new Map<
        string,
        IncomingRequest
    >();
    private readonly responses = new Map<
        string,
        CachedResponse
    >();
    private readonly leadershipWaiters = new Set<
        Deferred<LeadershipTerm>
    >();
    private readonly task: Task<void>;

    private channel:
        | BroadcastChannelResource<unknown>
        | undefined;
    private term: LeadershipTerm | undefined;
    private terminalError: Error | undefined;
    private closePromise: Promise<void> | undefined;

    constructor(
        private readonly options: LockBroadcastCoordinationOptions
    ) {
        super();
        this.scope = options.scope;
        this.requestTimeoutMs =
            options.requestTimeoutMs ??
            DEFAULT_REQUEST_TIMEOUT_MS;
        this.requestAttempts =
            options.requestAttempts ??
            DEFAULT_REQUEST_ATTEMPTS;
        this.responseCacheMs =
            options.responseCacheMs ??
            DEFAULT_RESPONSE_CACHE_MS;
        void this.ready.promise.catch(() => undefined);
        this.core = new HostCore({
            contextClient: (path, signal) =>
                this.createContextClient({ path, signal }),
            publishEvent: (service, event, payload) =>
                this.publishEvent(service, event, payload),
        });
        this.task = run(() => this.useLifetime());
        void this.task.catch((error: unknown) => {
            this.fail(normalizeError(error));
        });
    }

    get isLeader(): boolean {
        return this.term !== undefined;
    }

    serve<Service extends CoordinationService>(
        namespace: string,
        handlers: CoordinationServiceHandlers<Service>
    ): CoordinationServiceServer<Service> {
        this.assertOpen();
        return this.core.serve(namespace, handlers);
    }

    async runAsLeader<Result>(
        callback: (context: {
            signal: AbortSignal;
        }) => Result | Promise<Result>,
        options?: CoordinationCallOptions
    ): Promise<Result> {
        await waitForAbortable(
            this.ready.promise,
            options?.signal
        );
        this.throwTerminalError();
        const term = await this.waitForLeadership(
            options?.signal
        );
        try {
            return await runInScope(
                term.scope,
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
            );
        } catch (error) {
            if (this.closed) {
                throw new CoordinationClosedError();
            }
            if (
                this.term !== term ||
                term.signal.aborted
            ) {
                throw new CoordinationTransportError(
                    "Coordination leadership was lost.",
                    "TRANSPORT_ERROR",
                    { cause: normalizeError(error) }
                );
            }
            throw normalizeError(error);
        }
    }

    close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closed = true;
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

    private *useLifetime(): Operation<void> {
        const channelName = `party-stack.coordination:${this.scope}`;
        const rootScope = yield* useScope();
        const channel =
            yield* useBroadcastChannel<unknown>(
                channelName
            );
        this.channel = channel;
        this.rootScope.resolve(rootScope);

        try {
            void (yield* spawn(() =>
                this.processMessages(channel)
            ));
            void (yield* spawn(() =>
                this.useLeadership()
            ));
            this.ready.resolve();
            yield* suspend();
        } finally {
            const closeError = new CoordinationClosedError();
            yield* until(
                this.stopTerm(
                    this.term,
                    closeError
                )
            );
            yield* until(this.core.close());
            this.channel = undefined;
            this.rejectPending(closeError);
            this.rejectLeadershipWaiters(closeError);
            this.rootScope.reject(closeError);
        }
    }

    private *processMessages(
        messages: Stream<
            MessageEvent<unknown>,
            void
        >
    ): Operation<void> {
        for (const event of yield* each(messages)) {
            this.onMessage(event.data);
            yield* each.next();
        }
    }

    private *useLeadership(): Operation<void> {
        yield* useWebLock(
            `party-stack.coordination:${this.scope}:leader`
        );
        const scope = yield* useScope();
        const signal = yield* useAbortSignal();
        const term: LeadershipTerm = {
            scope,
            signal,
        };
        this.term = term;
        for (const waiter of this.leadershipWaiters) {
            waiter.resolve(term);
        }
        this.leadershipWaiters.clear();
        try {
            yield* suspend();
        } finally {
            yield* until(
                this.stopTerm(
                    term,
                    this.closed
                        ? new CoordinationClosedError()
                        : new CoordinationTransportError(
                              "Coordination leadership was lost.",
                              "TRANSPORT_ERROR"
                          )
                )
            );
        }
    }

    private *invokeOperation(
        namespace: string,
        method: string,
        input: unknown,
        path: readonly string[]
    ): Operation<unknown> {
        const signal = yield* useAbortSignal();
        yield* until(this.ready.promise);
        this.throwTerminalError();
        if (this.closed) throw new CoordinationClosedError();
        const term = this.term;
        if (term) {
            return yield* until(
                this.core.invoke(
                    namespace,
                    method,
                    input,
                    {
                        signal,
                        inheritedSignal: term.signal,
                        senderId: this.nodeId,
                        path,
                    }
                )
            );
        }
        return yield* this.requestRemote(
            namespace,
            method,
            input,
        );
    }

    private *requestRemote(
        service: string,
        method: string,
        payload: unknown,
    ): Operation<unknown> {
        const signal = yield* useAbortSignal();
        const requestId = randomId();
        const request: CoordinationRequestMessage = {
            v: COORDINATION_PROTOCOL_VERSION,
            scope: this.scope,
            type: "request",
            requestId,
            senderId: this.nodeId,
            service,
            method,
            payload,
        };
        const response = deferred<unknown>();
        this.pending.set(requestId, response);
        const cancel = () => {
            this.publish({
                v: COORDINATION_PROTOCOL_VERSION,
                scope: this.scope,
                type: "cancel",
                requestId,
                senderId: this.nodeId,
            } satisfies CoordinationCancelMessage);
        };
        try {
            for (
                let attempt = 0;
                attempt < this.requestAttempts;
                attempt++
            ) {
                if (signal.aborted) throw abortError(signal);
                if (this.term) {
                    return yield* until(
                        this.core.invoke(
                            service,
                            method,
                            payload,
                            {
                                signal,
                                inheritedSignal:
                                    this.term.signal,
                                requestId,
                                senderId:
                                    this.nodeId,
                                path: [],
                            }
                        )
                    );
                }
                this.publish(request);
                try {
                    return yield* this.waitForResponseAttempt(
                        response.promise,
                        service,
                        method,
                    );
                } catch (error) {
                    if (
                        !(
                            error instanceof
                                CoordinationTransportError
                        ) ||
                        error.code !== "TIMEOUT" ||
                        attempt === this.requestAttempts - 1
                    ) {
                        throw error;
                    }
                }
            }
            throw new CoordinationTransportError(
                `Coordination request "${service}.${method}" timed out.`,
                "TIMEOUT"
            );
        } finally {
            if (!response.settled) cancel();
            if (this.pending.get(requestId) === response) {
                this.pending.delete(requestId);
            }
        }
    }

    private *waitForResponseAttempt(
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
                `Coordination request "${service}.${method}" timed out.`,
                "TIMEOUT"
            );
        }
        return result.value;
    }

    private onMessage(message: unknown): void {
        if (this.closed || !isRecord(message)) return;
        const type = messageType(message);
        if (
            message.v !== COORDINATION_PROTOCOL_VERSION ||
            message.scope !== this.scope
        ) {
            this.handleProtocolMismatch(message, type);
            return;
        }
        if (message.senderId === this.nodeId) return;

        if (type === "response") {
            this.onResponse(
                message as unknown as CoordinationResponseMessage
            );
        } else if (type === "event") {
            const event =
                message as unknown as CoordinationEventMessage;
            this.emitEvent(
                event.service,
                event.event,
                event.payload
            );
        } else if (type === "cancel") {
            this.onCancel(
                message as unknown as CoordinationCancelMessage
            );
        } else if (type === "request" && this.term) {
            this.onRequest(
                message as unknown as CoordinationRequestMessage,
                this.term
            );
        }
    }

    private onResponse(
        response: CoordinationResponseMessage
    ): void {
        if (response.recipientId !== this.nodeId) return;
        const pending = this.pending.get(response.requestId);
        if (!pending) return;
        if (response.ok) {
            pending.resolve(response.result);
        } else {
            pending.reject(
                response.error
                    ? deserializeError(response.error)
                    : new CoordinationTransportError(
                          "Coordination response did not include an error.",
                          "TRANSPORT_ERROR"
                      )
            );
        }
    }

    private onRequest(
        request: CoordinationRequestMessage,
        term: LeadershipTerm
    ): void {
        const key = this.requestKey(
            request.senderId,
            request.requestId
        );
        this.pruneResponses();
        const cached = this.responses.get(key);
        if (cached) {
            this.publish(cached.response);
            return;
        }
        if (this.incoming.has(key)) return;

        const controller = new AbortController();
        const removeTermAbort = linkAbortSignal(
            term.signal,
            controller
        );
        const completion = this.core
            .invoke(
                request.service,
                request.method,
                request.payload,
                {
                    signal: controller.signal,
                    requestId: request.requestId,
                    senderId: request.senderId,
                    path: [],
                }
            )
            .then(
                (result) =>
                    this.completeIncoming(
                        key,
                        request,
                        term,
                        {
                            ok: true,
                            result,
                        }
                    ),
                (error: unknown) =>
                    this.completeIncoming(
                        key,
                        request,
                        term,
                        {
                            ok: false,
                            error: serializeError(error),
                        }
                    )
            )
            .finally(removeTermAbort);
        this.incoming.set(key, {
            controller,
            term,
            completion,
        });
        void completion;
    }

    private completeIncoming(
        key: string,
        request: CoordinationRequestMessage,
        term: LeadershipTerm,
        outcome:
            | { readonly ok: true; readonly result: unknown }
            | {
                  readonly ok: false;
                  readonly error: ReturnType<
                      typeof serializeError
                  >;
              }
    ): void {
        this.incoming.delete(key);
        if (
            this.closed ||
            this.term !== term ||
            term.signal.aborted
        ) {
            return;
        }
        const response: CoordinationResponseMessage = {
            v: COORDINATION_PROTOCOL_VERSION,
            scope: this.scope,
            type: "response",
            requestId: request.requestId,
            senderId: this.nodeId,
            recipientId: request.senderId,
            ...outcome,
        };
        this.responses.set(key, {
            response,
            expiresAt: Date.now() + this.responseCacheMs,
        });
        this.pruneResponses();
        this.publish(response);
    }

    private onCancel(message: CoordinationCancelMessage): void {
        const incoming = this.incoming.get(
            this.requestKey(
                message.senderId,
                message.requestId
            )
        );
        incoming?.controller.abort(
            new CoordinationTransportError(
                "Coordination request was cancelled by its caller.",
                "TRANSPORT_ERROR"
            )
        );
    }

    private handleProtocolMismatch(
        message: Record<string, unknown>,
        type: string | undefined
    ): void {
        const error = new CoordinationProtocolError(
            `Coordination protocol mismatch for scope "${this.scope}".`
        );
        if (
            type === "response" &&
            message.recipientId === this.nodeId &&
            typeof message.requestId === "string"
        ) {
            this.pending.get(message.requestId)?.reject(error);
            return;
        }
        if (
            type === "request" &&
            this.term &&
            typeof message.senderId === "string" &&
            typeof message.requestId === "string"
        ) {
            this.publish({
                v: COORDINATION_PROTOCOL_VERSION,
                scope: this.scope,
                type: "response",
                requestId: message.requestId,
                senderId: this.nodeId,
                recipientId: message.senderId,
                ok: false,
                error: serializeError(error),
            } satisfies CoordinationResponseMessage);
        }
    }

    private publishEvent(
        service: string,
        event: string,
        payload: unknown
    ): void {
        this.emitEvent(service, event, payload);
        this.publish({
            v: COORDINATION_PROTOCOL_VERSION,
            scope: this.scope,
            type: "event",
            senderId: this.nodeId,
            service,
            event,
            payload,
        } satisfies CoordinationEventMessage);
    }

    private publish(message: object): void {
        if (this.closed) return;
        try {
            this.channel?.postMessage(message);
        } catch (error) {
            this.fail(
                new CoordinationTransportError(
                    "Coordination broadcast failed.",
                    "TRANSPORT_ERROR",
                    { cause: error }
                )
            );
        }
    }

    private waitForLeadership(
        signal?: AbortSignal
    ): Promise<LeadershipTerm> {
        if (this.term) return Promise.resolve(this.term);
        if (this.closed) {
            return Promise.reject(new CoordinationClosedError());
        }
        if (this.terminalError) {
            return Promise.reject(this.terminalError);
        }
        const waiter = deferred<LeadershipTerm>();
        this.leadershipWaiters.add(waiter);
        if (!signal) return waiter.promise;
        const abort = () => {
            this.leadershipWaiters.delete(waiter);
            waiter.reject(abortError(signal));
        };
        if (signal.aborted) {
            abort();
        } else {
            signal.addEventListener("abort", abort, {
                once: true,
            });
            void waiter.promise.then(
                () =>
                    signal.removeEventListener("abort", abort),
                () =>
                    signal.removeEventListener("abort", abort)
            );
        }
        return waiter.promise;
    }

    private async stopTerm(
        term: LeadershipTerm | undefined,
        reason: Error
    ): Promise<void> {
        if (!term) return;
        const completions: Promise<void>[] = [];
        for (const incoming of this.incoming.values()) {
            if (incoming.term === term) {
                incoming.controller.abort(reason);
                completions.push(
                    incoming.completion
                );
            }
        }
        await Promise.allSettled(completions);
        if (this.term === term) {
            this.term = undefined;
        }
    }

    private fail(error: Error): void {
        if (this.terminalError) return;
        this.terminalError = error;
        this.ready.reject(error);
        this.rejectPending(error);
        this.rejectLeadershipWaiters(error);
        void this.task.halt().catch(
            () => undefined
        );
    }

    private throwTerminalError(): void {
        if (this.terminalError) throw this.terminalError;
    }

    private rejectPending(error: Error): void {
        for (const pending of this.pending.values()) {
            pending.reject(error);
        }
        this.pending.clear();
    }

    private rejectLeadershipWaiters(error: Error): void {
        for (const waiter of this.leadershipWaiters) {
            waiter.reject(error);
        }
        this.leadershipWaiters.clear();
    }

    private pruneResponses(): void {
        const now = Date.now();
        for (const [key, cached] of this.responses) {
            if (cached.expiresAt <= now) {
                this.responses.delete(key);
            }
        }
        while (this.responses.size > MAX_RESPONSE_CACHE_SIZE) {
            const first = this.responses.keys().next().value;
            if (typeof first !== "string") break;
            this.responses.delete(first);
        }
    }

    private requestKey(
        senderId: string,
        requestId: string
    ): string {
        return `${senderId}\u0000${requestId}`;
    }
}
