export interface CoordinationPortEvent {
    readonly data?: unknown;
}

export interface CoordinationMessagePort {
    postMessage(message: unknown): void;
    addEventListener(
        type: "message" | "messageerror" | "close",
        listener: (event: CoordinationPortEvent) => void
    ): void;
    removeEventListener(
        type: "message" | "messageerror" | "close",
        listener: (event: CoordinationPortEvent) => void
    ): void;
    start?(): void;
    close?(): void;
}

export interface SharedWorkerLike {
    readonly port: CoordinationMessagePort;
}

export type SharedWorkerSource =
    | CoordinationMessagePort
    | SharedWorkerLike
    | (() => CoordinationMessagePort | SharedWorkerLike);

export interface SharedWorkerCoordinationClientOptions {
    readonly scope: string;
    readonly worker: SharedWorkerSource;
    readonly connectionTimeoutMs?: number;
    readonly requestTimeoutMs?: number;
}

export interface SharedWorkerCoordinationHostOptions {
    readonly scope: string;
}
