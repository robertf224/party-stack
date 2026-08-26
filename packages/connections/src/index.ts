export {
    createConnectionManager,
    type CreateConnectionManagerOptions,
} from "./createConnectionManager.js";
export { createConnectionMonitor } from "./createConnectionMonitor.js";
export { createDefaultConnectionEgressHandlers } from "./createDefaultConnectionEgressHandlers.js";
export { withHttpAuthenticationErrorHandling } from "./withHttpAuthenticationErrorHandling.js";
export {
    withHttpRetryHandling,
    type HttpRetryHandlingOptions,
} from "./withHttpRetryHandling.js";
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
