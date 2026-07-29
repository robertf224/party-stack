import type { SerializedError } from "./internal.js";

interface ProtocolEnvelope {
    readonly v: number;
    readonly scope: string;
    readonly senderId: string;
}

export interface CoordinationRequestMessage
    extends ProtocolEnvelope {
    readonly type: "request";
    readonly requestId: string;
    readonly service: string;
    readonly method: string;
    readonly payload: unknown;
}

export interface CoordinationResponseMessage
    extends ProtocolEnvelope {
    readonly type: "response";
    readonly requestId: string;
    readonly recipientId: string;
    readonly ok: boolean;
    readonly result?: unknown;
    readonly error?: SerializedError;
}

export interface CoordinationCancelMessage
    extends ProtocolEnvelope {
    readonly type: "cancel";
    readonly requestId: string;
}

export interface CoordinationEventMessage
    extends ProtocolEnvelope {
    readonly type: "event";
    readonly service: string;
    readonly event: string;
    readonly payload: unknown;
}

export type CoordinationProtocolMessage =
    | CoordinationRequestMessage
    | CoordinationResponseMessage
    | CoordinationCancelMessage
    | CoordinationEventMessage;

export function isRecord(
    value: unknown
): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

export function messageType(
    value: unknown
): string | undefined {
    return isRecord(value) && typeof value.type === "string"
        ? value.type
        : undefined;
}
