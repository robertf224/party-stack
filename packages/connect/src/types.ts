import { Schema } from "effect";
import type { BackendError } from "@party-stack/ontology-backend";
import type { Stream } from "effect";
import type { Effect } from "effect";

export const ConnectionStateSchema = Schema.Union([
    Schema.Struct({ status: Schema.Literal("pending") }),
    Schema.Struct({
        status: Schema.Literal("active"),
        expiration: Schema.optional(Schema.Struct({ expiresAt: Schema.Number, refreshable: Schema.Boolean })),
    }),
    Schema.Struct({ status: Schema.Literal("inactive") }),
    Schema.Struct({ status: Schema.Literal("needs-auth"), error: Schema.optional(Schema.String) }),
    Schema.Struct({ status: Schema.Literal("error"), error: Schema.String }),
]);
export type ConnectionState = typeof ConnectionStateSchema.Type;

export type ConnectionStatus = ConnectionState["status"];

export interface ConnectionEgressHandlers {
    fetch(request: Request): Effect.Effect<Response, BackendError>;
    createWebSocket(url: string | URL, protocols?: string | string[]): Effect.Effect<WebSocket, BackendError>;
}

export interface ConnectionEgress {
    fetch(input: RequestInfo | URL, init?: RequestInit): Effect.Effect<Response, BackendError>;
    createWebSocket(url: string | URL, protocols?: string | string[]): Effect.Effect<WebSocket, BackendError>;
}

/** Serializable, reactive connection metadata and lifecycle state. */
export interface Connection<Status extends ConnectionStatus = ConnectionStatus> {
    userId: string;
    state: ConnectionState & { status: Status };
}

export interface ConnectionMonitor {
    readonly state: ConnectionState;
    /** Includes the current state, followed by connection lifecycle changes. */
    readonly changes: Stream.Stream<ConnectionState>;
}

/** What a replica that owns this connection's sync needs beyond the read-only monitor
 * apps show: renewing a credential that was rejected after egress returned, such as
 * a websocket the provider closes when its token expires. */
export interface ConnectionLifecycle extends ConnectionMonitor {
    /** Changes whenever the saved credential changes, including a renewal. */
    readonly credentialVersion: number;
    /** Renew the credential that was current at `version`. Does nothing when a newer
     * credential already replaced it. A renewal publishes a new active state; a
     * credential that cannot be renewed moves the connection to `needs-auth`. Fails
     * only for a retryable problem, such as the provider being unreachable. */
    readonly refresh: (version: number) => Effect.Effect<void, BackendError>;
}
