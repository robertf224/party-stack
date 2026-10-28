import type { BackendError } from "@party-stack/ontology-backend";

/** Recovery belongs to the replication controller, not an HTTP status mapper.
 * Restart only acquisition/delivery scopes; never discard outbox or user demand.
 */
export function deliveryRecovery(
    error: BackendError
): "selection" | "snapshot" | "session" | "reconnect" | "stop" {
    switch (error.kind) {
        case "ViewReplaced":
            return "selection";
        case "HistoryExpired":
            return "snapshot";
        case "SessionExpired":
        case "SessionReplaced":
            return "session";
        case "SourceMismatch":
        case "SchemaMismatch":
        case "ResultExpired":
        case "InvalidResponse":
        case "InvalidConfiguration":
            return "stop";
        default:
            return error.retryable ? "reconnect" : "stop";
    }
}
