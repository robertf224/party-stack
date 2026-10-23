import type { ConnectionError } from "./ConnectionError.js";
import type { UnauthenticatedError } from "@party-stack/errors";
import type { Runtime, RuntimeAdapter } from "@party-stack/runtime";
import type { Collection } from "@tanstack/db";
import type { Effect, Scope } from "effect";

export type ConnectionState =
    | { status: "pending" }
    | {
          status: "active";
          expiration?: {
              expiresAt: number;
              refreshable: boolean;
          };
      }
    | { status: "inactive" }
    | { status: "needs-auth"; error?: string }
    | { status: "error"; error: string };

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
    reportUnauthenticated(error: UnauthenticatedError): Promise<void>;
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
    runtime: RuntimeAdapter;
    scope: Scope.Scope;
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
    readonly connections: Collection<Connection, string>;
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
    readonly connections: Collection<Connection, string>;
    disconnect(userId: string): Effect.Effect<void, ConnectionError>;
    forget(userId: string): Effect.Effect<void, ConnectionError>;
    reportUnauthenticated(userId: string, error: UnauthenticatedError): Effect.Effect<void, ConnectionError>;
    egress(userId: string): ConnectionEgress | undefined;
}
