import {
    CoordinationClosedError,
    CoordinationServiceError,
    type CoordinationClient,
    type CoordinationService,
    type CoordinationServiceHandlers,
    type CoordinationServiceServer,
} from "./contracts.js";
import {
    abortError,
    deferred,
    linkAbortSignal,
    normalizeError,
    randomId,
    type Deferred,
} from "./internal.js";

type UntypedHandler = (
    input: unknown,
    context: {
        readonly requestId: string;
        readonly senderId: string;
        readonly signal: AbortSignal;
        readonly coordination: CoordinationClient;
    }
) => unknown;

interface Invocation {
    readonly method: string;
    readonly input: unknown;
    readonly requestId: string;
    readonly senderId: string;
    readonly path: readonly string[];
    readonly signals: readonly (AbortSignal | undefined)[];
    readonly result: Deferred<unknown>;
    removeQueuedAbort?: () => void;
}

interface Registration {
    readonly namespace: string;
    readonly handlers: Readonly<Record<string, UntypedHandler>>;
    readonly controller: AbortController;
    readonly queue: Invocation[];
    closed: boolean;
    drainPromise?: Promise<void>;
}

export interface HostInvocationOptions {
    readonly signal?: AbortSignal;
    readonly inheritedSignal?: AbortSignal;
    readonly requestId?: string;
    readonly senderId: string;
    readonly path: readonly string[];
}

export interface HostCoreOptions {
    readonly contextClient: (
        path: readonly string[],
        signal: AbortSignal
    ) => CoordinationClient;
    readonly publishEvent: (
        namespace: string,
        event: string,
        payload: unknown
    ) => void;
}

export class HostCore {
    private readonly registrations = new Map<
        string,
        Registration
    >();
    private closed = false;

    constructor(private readonly options: HostCoreOptions) {}

    serve<Service extends CoordinationService>(
        namespace: string,
        handlers: CoordinationServiceHandlers<Service>
    ): CoordinationServiceServer<Service> {
        if (this.closed) throw new CoordinationClosedError();
        if (this.registrations.has(namespace)) {
            throw new CoordinationServiceError(
                `Coordination service "${namespace}" is already registered.`,
                "DUPLICATE_SERVICE"
            );
        }

        const registration: Registration = {
            namespace,
            handlers: handlers as Readonly<
                Record<string, UntypedHandler>
            >,
            controller: new AbortController(),
            queue: [],
            closed: false,
        };
        this.registrations.set(namespace, registration);

        return {
            events: {
                publish: (event, payload) => {
                    if (
                        registration.closed ||
                        this.closed ||
                        this.registrations.get(namespace) !==
                            registration
                    ) {
                        return;
                    }
                    this.options.publishEvent(
                        namespace,
                        String(event),
                        payload
                    );
                },
            },
            close: () => this.closeRegistration(registration),
        };
    }

    invoke(
        namespace: string,
        method: string,
        input: unknown,
        options: HostInvocationOptions
    ): Promise<unknown> {
        if (this.closed) {
            return Promise.reject(new CoordinationClosedError());
        }
        const registration = this.registrations.get(namespace);
        if (!registration || registration.closed) {
            return Promise.reject(
                new CoordinationServiceError(
                    `Coordination service "${namespace}" is not available.`,
                    "SERVICE_UNAVAILABLE"
                )
            );
        }

        const current =
            options.path[options.path.length - 1];
        if (
            current !== namespace &&
            options.path.includes(namespace)
        ) {
            return Promise.reject(
                new CoordinationServiceError(
                    `Cyclic coordination service call to "${namespace}" is forbidden.`,
                    "CYCLIC_SERVICE_CALL"
                )
            );
        }

        const invocation = this.createInvocation(
            method,
            input,
            current === namespace
                ? options.path
                : [...options.path, namespace],
            options
        );

        if (current === namespace) {
            void this.execute(registration, invocation);
        } else {
            registration.queue.push(invocation);
            this.scheduleDrain(registration);
        }
        return invocation.result.promise;
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await Promise.all(
            [...this.registrations.values()].map((registration) =>
                this.closeRegistration(registration)
            )
        );
    }

    private createInvocation(
        method: string,
        input: unknown,
        path: readonly string[],
        options: HostInvocationOptions
    ): Invocation {
        const result = deferred<unknown>();
        const signals = [
            options.inheritedSignal,
            options.signal,
        ];
        const invocation: Invocation = {
            method,
            input,
            requestId: options.requestId ?? randomId(),
            senderId: options.senderId,
            path,
            signals,
            result,
        };

        const abort = () => {
            const signal = signals.find(
                (candidate) => candidate?.aborted
            );
            if (signal) result.reject(abortError(signal));
        };
        for (const signal of signals) {
            if (!signal) continue;
            if (signal.aborted) {
                abort();
                break;
            }
            signal.addEventListener("abort", abort, {
                once: true,
            });
        }
        invocation.removeQueuedAbort = () => {
            for (const signal of signals) {
                signal?.removeEventListener("abort", abort);
            }
        };
        return invocation;
    }

    private scheduleDrain(registration: Registration): void {
        if (registration.drainPromise) return;
        registration.drainPromise = Promise.resolve()
            .then(() => this.drain(registration))
            .finally(() => {
                registration.drainPromise = undefined;
                if (
                    !registration.closed &&
                    registration.queue.length > 0
                ) {
                    this.scheduleDrain(registration);
                }
            });
    }

    private async drain(registration: Registration): Promise<void> {
        while (!registration.closed) {
            const invocation = registration.queue.shift();
            if (!invocation) return;
            if (invocation.result.settled) {
                invocation.removeQueuedAbort?.();
                continue;
            }
            await this.execute(registration, invocation);
        }
    }

    private async execute(
        registration: Registration,
        invocation: Invocation
    ): Promise<void> {
        invocation.removeQueuedAbort?.();
        if (invocation.result.settled) return;

        const handler = registration.handlers[invocation.method];
        if (!handler) {
            invocation.result.reject(
                new CoordinationServiceError(
                    `Method "${invocation.method}" is not registered for service "${registration.namespace}".`,
                    "SERVICE_UNAVAILABLE"
                )
            );
            return;
        }

        const controller = new AbortController();
        const removeAbortLinks = [
            linkAbortSignal(
                registration.controller.signal,
                controller
            ),
            ...invocation.signals.map((signal) =>
                linkAbortSignal(signal, controller)
            ),
        ];
        const rejectOnAbort = () =>
            invocation.result.reject(
                abortError(controller.signal)
            );
        controller.signal.addEventListener(
            "abort",
            rejectOnAbort,
            { once: true }
        );

        try {
            if (controller.signal.aborted) {
                rejectOnAbort();
                return;
            }
            const value = await handler(invocation.input, {
                requestId: invocation.requestId,
                senderId: invocation.senderId,
                signal: controller.signal,
                coordination: this.options.contextClient(
                    invocation.path,
                    controller.signal
                ),
            });
            if (!controller.signal.aborted) {
                invocation.result.resolve(value);
            }
        } catch (error) {
            invocation.result.reject(normalizeError(error));
        } finally {
            controller.signal.removeEventListener(
                "abort",
                rejectOnAbort
            );
            for (const remove of removeAbortLinks) remove();
        }
    }

    private async closeRegistration(
        registration: Registration
    ): Promise<void> {
        if (registration.closed) {
            await registration.drainPromise;
            return;
        }
        registration.closed = true;
        const error = new CoordinationServiceError(
            `Coordination service "${registration.namespace}" is closed.`,
            "SERVICE_CLOSED"
        );
        registration.controller.abort(error);
        for (const invocation of registration.queue.splice(0)) {
            invocation.removeQueuedAbort?.();
            invocation.result.reject(error);
        }
        await registration.drainPromise;
        if (
            this.registrations.get(registration.namespace) ===
            registration
        ) {
            this.registrations.delete(registration.namespace);
        }
    }
}
