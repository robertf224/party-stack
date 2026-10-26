import { isUnauthenticatedError } from "@party-stack/ontology-backend";
import { Effect, Schema } from "effect";

export class ConnectionError extends Schema.TaggedError<ConnectionError>()("ConnectionError", {
    operation: Schema.String,
    kind: Schema.Literals(["Unavailable", "Unauthenticated", "Closed", "InvalidState"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
}) {
    static from(operation: string, cause: unknown): ConnectionError {
        return cause instanceof ConnectionError
            ? cause
            : new ConnectionError({
                  operation,
                  kind: isUnauthenticatedError(cause) ? "Unauthenticated" : "Unavailable",
                  message: isUnauthenticatedError(cause) ? cause.message : `Connection ${operation} failed.`,
                  cause,
              });
    }
}

/** The SDK/DOM boundary. Cancellation is passed through to APIs that support it. */
export const connectionOperation = <A>(operation: string, run: (signal: AbortSignal) => PromiseLike<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => ConnectionError.from(operation, cause) });
