import type { UnauthenticatedError } from "@party-stack/errors";
import type { RuntimeAdapter } from "@party-stack/runtime";
import type { Collection } from "@tanstack/db";

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
    refresh?(): Promise<EstablishedConnection>;
    disconnect(): Promise<void>;
    egress?(
        handlers: ConnectionEgressHandlers
    ): ConnectionEgressHandlers;
    cleanup?(): void | Promise<void>;
}

export interface EstablishedConnection {
    connection: Connection<"active">;
    session: ConnectionSession;
}

export interface ConnectionController {
    connect(
        connection: EstablishedConnection
    ): Promise<void>;
    disconnect(userId: string): Promise<void>;
}

export interface BackendConnectionAdapterContext {
    installationId: string;
    runtime: RuntimeAdapter;
}

export interface BackendConnectionAdapter<
    AuthenticationClient extends object = object,
> {
    readonly name: string;
    createAuthenticationClient(
        controller: ConnectionController
    ): AuthenticationClient;
    restoreConnections(): Promise<
        readonly EstablishedConnection[]
    >;
    cleanup?(): void | Promise<void>;
}

export type BackendConnectionAdapterProvider<
    AuthenticationClient extends object = object,
> = (
    context: BackendConnectionAdapterContext
) =>
    | BackendConnectionAdapter<AuthenticationClient>
    | Promise<BackendConnectionAdapter<AuthenticationClient>>;

export interface ConnectionManager<
    AuthenticationClient extends object = object,
> {
    readonly installationId: string;
    readonly authentication: AuthenticationClient;
    readonly connections: Collection<Connection, string>;
    disconnect(userId: string): Promise<void>;
    forget(userId: string): Promise<void>;
    reportUnauthenticated(
        userId: string,
        error: UnauthenticatedError
    ): Promise<void>;
    egress(userId: string): ConnectionEgress | undefined;
    cleanup(): Promise<void>;
}
