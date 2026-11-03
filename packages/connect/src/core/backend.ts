import { BackendError, schemaValidationIssues, makePropertyDecryption } from "@party-stack/ontology-backend";
import { compileEffectSchemas } from "@party-stack/ontology-spec/effect";
import { Effect, Redacted, Schema } from "effect";
import { connectOntology } from "../spec/index.js";
import { makeConnect } from "./Connect.js";
import { makeConnectPersistence } from "./store.js";
import type { ConnectOptions } from "./Connect.js";
import type { ConnectError } from "./errors.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";

const failure = (error: ConnectError) =>
    new BackendError({
        operation: "connect",
        retryable: error.retryable,
        kind:
            error.kind === "Configuration"
                ? "InvalidConfiguration"
                : error.kind === "NeedsAuthentication"
                  ? "Unauthenticated"
                  : error.kind === "InvalidAttempt"
                    ? "InvalidRequest"
                    : error.kind === "Busy"
                      ? "Conflict"
                      : error.kind === "Provider" || error.kind === "Storage"
                        ? "Unavailable"
                        : error.kind,
        message: error.message,
        // An exchange can fail after the provider has consumed a single-use credential.
        actionOutcome:
            error.kind === "Provider" || error.kind === "Storage" || error.kind === "NeedsAuthentication"
                ? "unknown"
                : "not-committed",
    });

/** Private credential authority exposed through ordinary ontology reads/actions.
 * Apply a server policy before serving untrusted callers: connection/token records,
 * principal binding, callback URLs and connector access belong to that policy.
 * Call these actions directly through the backend/protocol, not a durable UI outbox.
 */
export const makeConnectBackend = Effect.fn("Connect.backend")(function* (
    options: Omit<ConnectOptions, "store"> & Parameters<typeof makeConnectPersistence>[0]
) {
    const { store, backend: persistence } = yield* makeConnectPersistence(options);
    const connect = yield* makeConnect({ ...options, store });
    const schemas = compileEffectSchemas(options.ir ?? connectOntology);
    // This is an adapter over a multi-transaction workflow, not an owned mutator.
    // Do not expose `storage`: server projection must check/bind inputs before IO,
    // rather than relying on the owned backend's transaction authorization hook.
    const { storage: _storage, ...reads } = persistence;
    const backend: OntologyBackendService = {
        ...reads,
        name: "connect",
        encrypted: makePropertyDecryption({
            ir: options.ir ?? connectOntology,
            get: (type, key) => persistence.storage.read((tx) => tx.get(type, key)),
            decrypt: (handle) =>
                options.values.decrypt(Schema.Unknown, handle).pipe(
                    Effect.mapError(
                        () =>
                            new BackendError({
                                operation: "decrypt",
                                kind: "Unavailable",
                                retryable: false,
                                message: "Encrypted value is unavailable.",
                            })
                    )
                ),
        }),
        // Native claims prevent repeated code exchange; they do not make arbitrary
        // action IDs idempotent. A generic durable workflow/result hook is future work.
        supportsIdempotency: false,
        applyAction: Effect.fn("Connect.applyAction")(function* (request) {
            const definition = connectOntology.actionTypes.find((action) => action.name === request.name);
            if (!definition)
                return yield* new BackendError({
                    operation: "applyAction",
                    kind: "NotImplemented",
                    retryable: false,
                    actionOutcome: "not-committed",
                    message: "Unknown Connect action.",
                });
            if (request.attachmentUploads?.length)
                return yield* new BackendError({
                    operation: "applyAction",
                    kind: "InvalidRequest",
                    retryable: false,
                    actionOutcome: "not-committed",
                    message: "Connect actions do not accept attachments.",
                });
            const args = yield* Schema.decodeUnknownEffect(
                Schema.toEncoded(schemas.actionParameterSchemas[request.name]!)
            )(request.parameters).pipe(
                Effect.mapError(
                    (error) =>
                        new BackendError({
                            operation: "applyAction",
                            kind: "ValidationFailed",
                            retryable: false,
                            actionOutcome: "not-committed",
                            message: "Action parameters do not match their definition.",
                            issues: schemaValidationIssues(error),
                        })
                )
            );
            const text = (name: string) => args[name] as string;
            const optionalText = (name: string) =>
                typeof args[name] === "string" ? (args[name] as string) : undefined;
            const result = yield* Effect.gen(function* () {
                switch (definition.name) {
                    case "beginAuthorization":
                        return yield* connect.begin({
                            connectorId: text("connectorId"),
                            principalId: text("principalId"),
                            redirectUrl: text("redirectUrl"),
                            returnUrl: optionalText("returnUrl"),
                            connectionId: optionalText("connectionId"),
                        });
                    case "completeAuthorization":
                        return {
                            connectionId: (yield* connect.complete({
                                callbackUrl: text("callbackUrl"),
                                principalId: text("principalId"),
                            })).id,
                        };
                    case "connectClientCredentials":
                        return {
                            connectionId: (yield* connect.clientCredentials({
                                connectorId: text("connectorId"),
                                connectionId: optionalText("connectionId"),
                            })).id,
                        };
                    case "refreshConnection":
                        return { connectionId: (yield* connect.refresh(text("connectionId"))).id };
                    case "disconnectConnection":
                        return yield* connect.disconnect(text("connectionId"));
                }
            }).pipe(Effect.mapError(failure));
            const codec = schemas.actionReturnSchemas[request.name];
            const encoded = codec
                ? yield* Schema.encodeEffect(Schema.toCodecJson(codec))(result).pipe(
                      Effect.mapError(
                          (cause) =>
                              new BackendError({
                                  operation: "applyAction.result",
                                  kind: "InvalidResponse",
                                  retryable: false,
                                  message: "Connect returned an invalid action result.",
                                  cause: Redacted.make(cause),
                              })
                      )
                  )
                : undefined;
            return { operationId: request.id, outcome: "committed" as const, result: encoded };
        }),
    };
    return { backend, connect, store };
});
