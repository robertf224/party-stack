import { Schema } from "effect";

/** Provider bodies, codes, tokens and authorization URLs must never enter errors. */
export class ConnectError extends Schema.TaggedError<ConnectError>()("ConnectError", {
    kind: Schema.Literals([
        "Configuration",
        "NotFound",
        "Forbidden",
        "NeedsAuthentication",
        "Busy",
        "InvalidAttempt",
        "Provider",
        "Storage",
    ]),
    message: Schema.String,
    retryable: Schema.Boolean,
}) {}
export const connectError = (kind: ConnectError["kind"], message: string, retryable = false) =>
    new ConnectError({ kind, message, retryable });
