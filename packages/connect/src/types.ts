import { Schema } from "effect";
import type { ConnectionError } from "./ConnectionError.js";
import type { UnauthenticatedError } from "@party-stack/ontology-backend";
import type { Runtime } from "@party-stack/runtime";
import type { Effect, Scope, Stream } from "effect";

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
    fetch(request: Request): Promise<Response>;
    createWebSocket(url: string | URL, protocols?: string | string[]): Promise<WebSocket>;
}

export interface ConnectionEgress {
    fetch: typeof globalThis.fetch;
    createWebSocket(url: string | URL, protocols?: string | string[]): Promise<WebSocket>;
}

/** Serializable, reactive connection metadata and lifecycle state. */
export interface Connection<Status extends ConnectionStatus = ConnectionStatus> {
    userId: string;
    state: ConnectionState & { status: Status };
}

export interface ConnectionMonitor {
    readonly state: ConnectionState;
    subscribe(callback: (state: ConnectionState) => void): () => void;
    /** Includes the current state, followed by connection lifecycle changes. */
    readonly changes: Stream.Stream<ConnectionState>;
    reportUnauthenticated(error: UnauthenticatedError): Effect.Effect<void, ConnectionError>;
}

export interface ConnectionSession {
    refresh?(): Effect.Effect<EstablishedConnection, ConnectionError>;
    disconnect(): Effect.Effect<void, ConnectionError>;
    egress?(handlers: ConnectionEgressHandlers): ConnectionEgressHandlers;
    cleanup?(): Effect.Effect<void>;
}

export interface EstablishedConnection {
    connection: Connection<"active">;
    session: ConnectionSession;
}

export interface ConnectionController {
    connect(connection: EstablishedConnection): Effect.Effect<void, ConnectionError>;
    disconnect(userId: string): Effect.Effect<void, ConnectionError>;
}

export interface BackendConnectionAdapterContext {
    installationId: string;
}

export interface BackendConnectionAdapter<AuthenticationClient extends object = object> {
    readonly name: string;
    createAuthenticationClient(controller: ConnectionController): AuthenticationClient;
    restoreConnections(): Effect.Effect<readonly EstablishedConnection[], ConnectionError>;
    cleanup?(): Effect.Effect<void>;
}

export type BackendConnectionAdapterProvider<AuthenticationClient extends object = object> = (
    context: BackendConnectionAdapterContext
) => Effect.Effect<BackendConnectionAdapter<AuthenticationClient>, ConnectionError, Runtime | Scope.Scope>;

export interface ConnectionManager<AuthenticationClient extends object = object> {
    readonly installationId: string;
    readonly authentication: AuthenticationClient;
    readonly connections: ReadonlyMap<string, Connection>;
    readonly connectionChanges: Stream.Stream<readonly Connection[]>;
    /** Observer of the connection records owned by this service. */
    subscribeConnection(userId: string, listener: (state: ConnectionState) => void): () => void;
    refreshConnections(): Promise<void>;
    disconnect(userId: string): Promise<void>;
    forget(userId: string): Promise<void>;
    reportUnauthenticated(userId: string, error: UnauthenticatedError): Promise<void>;
    egress(userId: string): ConnectionEgress | undefined;
    cleanup(): Promise<void>;
}

/** Scoped service; UI and SDK consumers can use the Promise client above. */
export interface ConnectionManagerService<AuthenticationClient extends object = object> {
    readonly installationId: string;
    readonly authentication: AuthenticationClient;
    readonly connections: ReadonlyMap<string, Connection>;
    readonly connectionChanges: Stream.Stream<readonly Connection[]>;
    /** Observer of the connection records owned by this service. */
    subscribeConnection(userId: string, listener: (state: ConnectionState) => void): () => void;
    refreshConnections(): Effect.Effect<void, ConnectionError>;
    disconnect(userId: string): Effect.Effect<void, ConnectionError>;
    forget(userId: string): Effect.Effect<void, ConnectionError>;
    reportUnauthenticated(userId: string, error: UnauthenticatedError): Effect.Effect<void, ConnectionError>;
    egress(userId: string): ConnectionEgress | undefined;
}
