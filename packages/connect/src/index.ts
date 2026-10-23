export {
    Connections,
    makeConnectionManager,
    createConnectionManager,
    type CreateConnectionManagerOptions,
    type ConnectionManagerOptions,
} from "./createConnectionManager.js";
export { createConnectionMonitor } from "./createConnectionMonitor.js";
export { createDefaultConnectionEgressHandlers } from "./createDefaultConnectionEgressHandlers.js";
export { withHttpAuthenticationErrorHandling } from "./withHttpAuthenticationErrorHandling.js";
export { withHttpRetryHandling, type HttpRetryHandlingOptions } from "./withHttpRetryHandling.js";
export type {
    BackendConnectionAdapter,
    BackendConnectionAdapterContext,
    BackendConnectionAdapterProvider,
    Connection,
    ConnectionController,
    ConnectionEgress,
    ConnectionEgressHandlers,
    ConnectionManager,
    ConnectionMonitor,
    ConnectionSession,
    ConnectionState,
    ConnectionStatus,
    EstablishedConnection,
} from "./types.js";
export { Connect, makeConnect } from "./core/Connect.js";
export type {
    ConnectService,
    ConnectOptions,
    ConnectOAuthProvider,
    OAuthTokens,
    BeginAuthorization,
} from "./core/Connect.js";
export { ConnectError } from "./core/errors.js";
export { makeConnectStore } from "./core/store.js";
export type { ConnectStore } from "./core/store.js";
export { makeOAuthProvider } from "./core/oauth.js";
export type { OAuthProviderOptions } from "./core/oauth.js";
export { makeServerConnectClient } from "./serverClient.js";
export { maintainConnect } from "./core/maintenance.js";
export type { ConnectCredentialValues } from "./core/Connect.js";
export * from "./oauth/index.js";

export { ConnectionError, connectionOperation } from "./ConnectionError.js";
export type { ConnectionManagerService } from "./types.js";
