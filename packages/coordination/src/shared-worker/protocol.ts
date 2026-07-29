import type { SerializedError } from "../internal.js";

interface WorkerEnvelope {
    readonly v: number;
    readonly scope: string;
    readonly connectionId: string;
}

export interface WorkerHello extends WorkerEnvelope {
    readonly type: "hello";
}

export interface WorkerWelcome extends WorkerEnvelope {
    readonly type: "welcome";
    readonly accepted: boolean;
    readonly error?: SerializedError;
}

export interface WorkerRequest extends WorkerEnvelope {
    readonly type: "request";
    readonly requestId: string;
    readonly service: string;
    readonly method: string;
    readonly payload: unknown;
}

export interface WorkerResponse extends WorkerEnvelope {
    readonly type: "response";
    readonly requestId: string;
    readonly ok: boolean;
    readonly result?: unknown;
    readonly error?: SerializedError;
}

export interface WorkerCancel extends WorkerEnvelope {
    readonly type: "cancel";
    readonly requestId: string;
}

export interface WorkerEvent extends WorkerEnvelope {
    readonly type: "event";
    readonly service: string;
    readonly event: string;
    readonly payload: unknown;
}

export interface WorkerDisconnect extends WorkerEnvelope {
    readonly type: "disconnect";
    readonly error?: SerializedError;
}

export type WorkerMessage =
    | WorkerHello
    | WorkerWelcome
    | WorkerRequest
    | WorkerResponse
    | WorkerCancel
    | WorkerEvent
    | WorkerDisconnect;
