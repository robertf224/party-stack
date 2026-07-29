import {
    CoordinationClosedError,
    type CoordinationCallOptions,
    type CoordinationClient,
    type CoordinationService,
    type CoordinationServiceClient,
    type CoordinationServiceMethods,
} from "./contracts.js";

type EventListener = (payload: unknown) => void;

export interface InvocationContext {
    readonly path: readonly string[];
    readonly signal?: AbortSignal;
}

export abstract class BaseCoordination
    implements CoordinationClient
{
    abstract readonly role: "client" | "host";

    protected closed = false;

    private readonly clients = new Map<
        string,
        CoordinationServiceClient<CoordinationService>
    >();
    private readonly listeners = new Map<
        string,
        Map<string, Set<EventListener>>
    >();

    service<Service extends CoordinationService>(
        namespace: string
    ): CoordinationServiceClient<Service> {
        this.assertNamespace(namespace);
        const existing = this.clients.get(namespace);
        if (existing) {
            return existing as CoordinationServiceClient<Service>;
        }
        const client = this.createServiceClient<Service>(
            namespace,
            { path: [] }
        );
        this.clients.set(
            namespace,
            client as CoordinationServiceClient<CoordinationService>
        );
        return client;
    }

    abstract close(): Promise<void>;

    protected abstract invokeRequest(
        namespace: string,
        method: string,
        input: unknown,
        options: CoordinationCallOptions | undefined,
        context: InvocationContext
    ): Promise<unknown>;

    protected createContextClient(
        context: InvocationContext
    ): CoordinationClient {
        const getRole = () => this.role;
        return {
            get role() {
                return getRole();
            },
            service: <Service extends CoordinationService>(
                namespace: string
            ) => {
                this.assertNamespace(namespace);
                return this.createServiceClient<Service>(
                    namespace,
                    context
                );
            },
            close: () => this.close(),
        };
    }

    protected emitEvent(
        namespace: string,
        event: string,
        payload: unknown
    ): void {
        if (this.closed) return;
        const listeners = this.listeners
            .get(namespace)
            ?.get(event);
        if (!listeners) return;
        for (const listener of [...listeners]) {
            try {
                listener(payload);
            } catch {
                // One subscriber must not prevent fan-out to others.
            }
        }
    }

    protected clearEventListeners(): void {
        this.listeners.clear();
        this.clients.clear();
    }

    protected assertOpen(): void {
        if (this.closed) throw new CoordinationClosedError();
    }

    private createServiceClient<Service extends CoordinationService>(
        namespace: string,
        context: InvocationContext
    ): CoordinationServiceClient<Service> {
        const methodCache = new Map<
            PropertyKey,
            (input: unknown, options?: CoordinationCallOptions) => Promise<unknown>
        >();
        const methods = new Proxy<Record<PropertyKey, unknown>>(
            {},
            {
                get: (_target, property) => {
                    if (typeof property !== "string") return undefined;
                    if (property === "then") return undefined;
                    let method = methodCache.get(property);
                    if (!method) {
                        method = (input, options) =>
                            this.invokeRequest(
                                namespace,
                                property,
                                input,
                                options,
                                context
                            );
                        methodCache.set(property, method);
                    }
                    return method;
                },
            }
        ) as CoordinationServiceMethods<Service>;

        return {
            methods,
            events: {
                subscribe: (event, callback) => {
                    if (this.closed) return () => undefined;
                    const eventName = String(event);
                    const namespaceListeners =
                        this.listeners.get(namespace) ??
                        new Map<string, Set<EventListener>>();
                    const eventListeners =
                        namespaceListeners.get(eventName) ??
                        new Set<EventListener>();
                    this.listeners.set(namespace, namespaceListeners);
                    namespaceListeners.set(
                        eventName,
                        eventListeners
                    );
                    const listener = callback as EventListener;
                    eventListeners.add(listener);

                    return () => {
                        eventListeners.delete(listener);
                        if (eventListeners.size === 0) {
                            namespaceListeners.delete(eventName);
                        }
                        if (namespaceListeners.size === 0) {
                            this.listeners.delete(namespace);
                        }
                    };
                },
            },
        };
    }

    private assertNamespace(namespace: string): void {
        if (namespace.length === 0) {
            throw new TypeError(
                "Coordination service namespace must not be empty."
            );
        }
    }
}
