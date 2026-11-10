import { Schema } from "effect";

export class WatcherError extends Schema.TaggedError<WatcherError>()("WatcherError", {
    reason: Schema.Literals(["Open", "Closed", "Protocol", "Overflow", "Timeout", "QoS"]),
    cause: Schema.optional(Schema.Defect()),
}) {}
export interface WatcherOptions {
    readonly heartbeatMs?: number;
    readonly responseTimeoutMs?: number;
    readonly retryDelayMs?: number;
}
