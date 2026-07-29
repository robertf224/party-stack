export const COORDINATION_PROTOCOL_VERSION = 1 as const;

export interface CoordinationService {
    methods: Record<
        string,
        (input: never) => Promise<unknown>
    >;
    events: Record<string, unknown>;
}

type ServiceMethod<
    Service extends CoordinationService,
    Method extends keyof Service["methods"],
> = Service["methods"][Method];

export type CoordinationMethodInput<
    Service extends CoordinationService,
    Method extends keyof Service["methods"],
> = ServiceMethod<Service, Method> extends (
    input: infer Input
) => Promise<unknown>
    ? Input
    : never;

export type CoordinationMethodResult<
    Service extends CoordinationService,
    Method extends keyof Service["methods"],
> = ServiceMethod<Service, Method> extends (
    input: never
) => infer Result
    ? Awaited<Result>
    : never;

export interface CoordinationCallOptions {
    signal?: AbortSignal;
}

export type CoordinationServiceMethods<
    Service extends CoordinationService,
> = {
    readonly [Method in keyof Service["methods"]]: (
        input: CoordinationMethodInput<Service, Method>,
        options?: CoordinationCallOptions
    ) => Promise<CoordinationMethodResult<Service, Method>>;
};

export interface CoordinationServiceEvents<
    Service extends CoordinationService,
> {
    subscribe<Event extends keyof Service["events"]>(
        event: Event,
        callback: (value: Service["events"][Event]) => void
    ): () => void;
}

export interface CoordinationServiceClient<
    Service extends CoordinationService,
> {
    readonly methods: CoordinationServiceMethods<Service>;
    readonly events: CoordinationServiceEvents<Service>;
}

export interface CoordinationTaskContext {
    readonly requestId: string;
    readonly senderId: string;
    readonly signal: AbortSignal;
    readonly coordination: CoordinationClient;
}

export type CoordinationServiceHandler<
    Service extends CoordinationService,
    Method extends keyof Service["methods"],
> = (
    input: CoordinationMethodInput<Service, Method>,
    context: CoordinationTaskContext
) =>
    | CoordinationMethodResult<Service, Method>
    | PromiseLike<CoordinationMethodResult<Service, Method>>;

export type CoordinationServiceHandlers<
    Service extends CoordinationService,
> = {
    readonly [Method in keyof Service["methods"]]: CoordinationServiceHandler<
        Service,
        Method
    >;
};

export interface CoordinationServicePublisher<
    Service extends CoordinationService,
> {
    publish<Event extends keyof Service["events"]>(
        event: Event,
        payload: Service["events"][Event]
    ): void;
}

export interface CoordinationServiceServer<
    Service extends CoordinationService,
> {
    readonly events: CoordinationServicePublisher<Service>;
    close(): Promise<void>;
}

export interface CoordinationClient {
    readonly role: "client" | "host";

    service<Service extends CoordinationService>(
        namespace: string
    ): CoordinationServiceClient<Service>;

    close(): Promise<void>;
}

export interface CoordinationHost extends CoordinationClient {
    readonly role: "host";
    readonly isLeader: boolean;

    serve<Service extends CoordinationService>(
        namespace: string,
        handlers: CoordinationServiceHandlers<Service>
    ): CoordinationServiceServer<Service>;

    runAsLeader<Result>(
        callback: (context: {
            signal: AbortSignal;
        }) => Result | Promise<Result>,
        options?: CoordinationCallOptions
    ): Promise<Result>;
}

export type Coordination = CoordinationClient | CoordinationHost;

export function isCoordinationHost(
    value: Coordination
): value is CoordinationHost {
    return value.role === "host";
}

export interface CoordinationOptions {
    readonly scope: string;
}

export interface LockBroadcastCoordinationOptions
    extends CoordinationOptions {
    readonly requestTimeoutMs?: number;
    readonly requestAttempts?: number;
    readonly responseCacheMs?: number;
}

export type CoordinationErrorCode =
    | "ABORTED"
    | "CLOSED"
    | "CYCLIC_SERVICE_CALL"
    | "DISCONNECTED"
    | "DUPLICATE_SERVICE"
    | "HANDLER_ERROR"
    | "PROTOCOL_MISMATCH"
    | "SERVICE_CLOSED"
    | "SERVICE_UNAVAILABLE"
    | "TIMEOUT"
    | "TRANSPORT_ERROR";

export class CoordinationError extends Error {
    constructor(
        message: string,
        readonly code: CoordinationErrorCode,
        options?: ErrorOptions
    ) {
        super(message, options);
        this.name = "CoordinationError";
    }
}

export class CoordinationClosedError extends CoordinationError {
    constructor(message = "Coordination is closed.") {
        super(message, "CLOSED");
        this.name = "CoordinationClosedError";
    }
}

export class CoordinationServiceError extends CoordinationError {
    constructor(
        message: string,
        code:
            | "CYCLIC_SERVICE_CALL"
            | "DUPLICATE_SERVICE"
            | "HANDLER_ERROR"
            | "SERVICE_CLOSED"
            | "SERVICE_UNAVAILABLE",
        options?: ErrorOptions
    ) {
        super(message, code, options);
        this.name = "CoordinationServiceError";
    }
}

export class CoordinationTaskRejectedError extends Error {
    constructor(
        message: string,
        readonly code = "INVALID_TASK",
        options?: ErrorOptions
    ) {
        super(message, options);
        this.name = "CoordinationTaskRejectedError";
    }
}

export class CoordinationProtocolError extends CoordinationError {
    constructor(message: string) {
        super(message, "PROTOCOL_MISMATCH");
        this.name = "CoordinationProtocolError";
    }
}

export class CoordinationTransportError extends CoordinationError {
    constructor(
        message: string,
        code: "DISCONNECTED" | "TIMEOUT" | "TRANSPORT_ERROR",
        options?: ErrorOptions
    ) {
        super(message, code, options);
        this.name = "CoordinationTransportError";
    }
}
