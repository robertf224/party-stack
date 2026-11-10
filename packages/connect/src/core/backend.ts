import { BackendError, schemaValidationIssues, makePropertyDecryption } from "@party-stack/ontology-backend";
import { compileEffectSchemas } from "@party-stack/ontology-spec/effect";
import { and, eq, field } from "@party-stack/ontology-storage";
import { Clock, Effect, Redacted, Schema } from "effect";
import { connectOntology } from "../spec/index.js";
import { connectError } from "./errors.js";
import { maintainConnect } from "./maintenance.js";
import { makeOAuthAuthority } from "./oauthAuthority.js";
import { makeConnectPersistence } from "./store.js";
import type { ServiceConnector } from "../ServiceConnector.js";
import type { ConnectError } from "./errors.js";
import type { OAuthAuthorityOptions } from "./oauthAuthority.js";
import type { ActionRequest, OntologyBackendService } from "@party-stack/ontology-backend";
import type { Scope } from "effect";

export type ConnectActionHandler = (
    request: ActionRequest
) => Effect.Effect<unknown, BackendError | ConnectError, Scope.Scope>;

export const connectBackendError = (error: ConnectError) =>
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
        // An exchange can fail after the oauth has consumed a single-use credential.
        actionOutcome:
            error.kind === "Provider" || error.kind === "Storage" || error.kind === "NeedsAuthentication"
                ? "unknown"
                : "not-committed",
    });

/** Private credential authority exposed through ordinary ontology reads/actions.
 * Apply a server policy before serving untrusted callers: connection/token records,
 * principal binding, callback URLs and application access belong to that policy.
 * Call these actions directly through the backend/protocol, not a durable UI outbox.
 */
export const makeConnectBackend = Effect.fn("Connect.backend")(
    function* (
        options: Omit<OAuthAuthorityOptions, "store" | "oauth"> &
            Parameters<typeof makeConnectPersistence>[0] & {
                readonly oauth?: OAuthAuthorityOptions["oauth"];
                readonly services?: readonly ServiceConnector[];
                /** Declared application workflow actions; parameters and results use the supplied IR. */
                readonly actionHandlers?: Readonly<Record<string, ConnectActionHandler>>;
            }
    ) {
        for (const name of Object.keys(options.actionHandlers ?? {})) {
            if (
                connectOntology.actionTypes.some((action) => action.name === name) ||
                !(options.ir ?? connectOntology).actionTypes.some((action) => action.name === name)
            )
                return yield* new BackendError({
                    operation: "connect.configure",
                    kind: "InvalidConfiguration",
                    retryable: false,
                    message: "Application handlers must declare a new action in the Connect ontology.",
                });
        }
        const { store, backend: persistence } = yield* makeConnectPersistence({
            ...options,
            maintenance: false,
        });
        const services = new Map(options.services?.map((service) => [service.service, service]));
        if (services.size !== (options.services?.length ?? 0))
            return yield* connectBackendError(
                connectError("Configuration", "Service connector names must be unique.")
            );
        const connect = yield* makeOAuthAuthority({
            ...options,
            store,
            oauth:
                options.oauth ??
                ((input) => {
                    const service = services.get(input.serviceInstance.service);
                    return service?.oauth
                        ? service.oauth({ ...input, values: options.values })
                        : Effect.fail(connectError("Configuration", "This service does not support OAuth."));
                }),
        });
        const instance = Effect.fnUntraced(function* (id: string) {
            const value = yield* store.get("ServiceInstance", id);
            if (!value) return yield* connectError("NotFound", "Service instance is unavailable.");
            const service = services.get(value.service);
            if (!service) return yield* connectError("Configuration", "Service connector is unavailable.");
            return { value, service };
        });
        const schemas = compileEffectSchemas(options.ir ?? connectOntology);
        // This is an adapter over a multi-transaction workflow, not an owned mutator.
        // Do not expose `storage`: server projection must check/bind inputs before IO,
        // rather than relying on the owned backend's transaction authorization hook.
        const { storage: _storage, ...reads } = persistence;
        const backend: OntologyBackendService = {
            ...reads,
            name: "connect",
            maintenance: Effect.gen(function* () {
                yield* persistence.maintenance ?? Effect.void;
                yield* connect.collectExpired().pipe(Effect.mapError(connectBackendError));
            }),
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
                const definition = (options.ir ?? connectOntology).actionTypes.find(
                    (action) => action.name === request.name
                );
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
                    const handlers = options.actionHandlers;
                    const handler =
                        handlers && Object.hasOwn(handlers, definition.name)
                            ? handlers[definition.name]
                            : undefined;
                    if (
                        handler &&
                        !connectOntology.actionTypes.some((action) => action.name === definition.name)
                    )
                        return yield* Effect.scoped(handler({ ...request, parameters: args }));
                    switch (definition.name) {
                        case "beginAuthorization":
                            return yield* connect.begin({
                                applicationId: text("applicationId"),
                                principalId: optionalText("principalId"),
                                redirectUrl: text("redirectUrl"),
                                returnUrl: optionalText("returnUrl"),
                                connectionId: optionalText("connectionId"),
                            });
                        case "completeAuthorization":
                            return {
                                connectionId: (yield* connect.complete({
                                    callbackUrl: text("callbackUrl"),
                                    principalId: optionalText("principalId"),
                                })).id,
                            };
                        case "connectClientCredentials":
                            return {
                                connectionId: (yield* connect.clientCredentials({
                                    applicationId: text("applicationId"),
                                    connectionId: optionalText("connectionId"),
                                })).id,
                            };
                        case "refreshConnection":
                            return { connectionId: (yield* connect.refresh(text("connectionId"))).id };
                        case "disconnectConnection":
                            return yield* connect.disconnect(text("connectionId"));
                        case "forgetConnection":
                            return yield* connect.forget(text("connectionId"));
                        case "connectApiKey": {
                            const { value, service } = yield* instance(text("serviceInstanceId"));
                            if (!service.apiKey)
                                return yield* connectError(
                                    "Configuration",
                                    "This service does not accept API keys."
                                );
                            const identity = yield* service.apiKey({
                                serviceInstance: value,
                                apiKey: text("apiKey"),
                            });
                            if (
                                identity.expiresAt &&
                                identity.expiresAt.epochMilliseconds <= (yield* Clock.currentTimeMillis)
                            )
                                return yield* connectError("NeedsAuthentication", "The API key has expired.");
                            const id = JSON.stringify([value.id, identity.userId]);
                            const apiKey = yield* options.values
                                .encrypt(Schema.String, text("apiKey"))
                                .pipe(
                                    Effect.mapError(() =>
                                        connectError("Storage", "Could not encrypt the API key.")
                                    )
                                );
                            yield* store.put("ApiKeyConnection", {
                                id,
                                serviceInstance: value.id,
                                userId: identity.userId,
                                title: identity.title ?? identity.userId,
                                status: "active",
                                apiKey,
                                expiresAt: identity.expiresAt,
                            });
                            return { connectionId: id };
                        }
                        case "attachExternalSession": {
                            const { value, service } = yield* instance(text("serviceInstanceId"));
                            if (!service.externalSession)
                                return yield* connectError(
                                    "Configuration",
                                    "This service does not accept external sessions."
                                );
                            const sessionId = text("sessionId");
                            const identity = yield* service.externalSession({
                                serviceInstance: value,
                                sessionId,
                            });
                            if (
                                identity.expiresAt &&
                                identity.expiresAt.epochMilliseconds <= (yield* Clock.currentTimeMillis)
                            )
                                return yield* connectError(
                                    "NeedsAuthentication",
                                    "The external session has expired."
                                );
                            const id = yield* store.transaction(
                                Effect.gen(function* () {
                                    const sameSession = (yield* store.load("ExternalSessionConnection", {
                                        where: and(
                                            eq(field("serviceInstance"), value.id),
                                            eq(field("sessionId"), sessionId)
                                        ),
                                        limit: 1,
                                    }))[0];
                                    if (sameSession && sameSession.userId !== identity.userId)
                                        return yield* connectError(
                                            "Forbidden",
                                            "The external session identity changed."
                                        );
                                    const previous = (yield* store.load("ExternalSessionConnection", {
                                        where: and(
                                            eq(field("serviceInstance"), value.id),
                                            eq(field("userId"), identity.userId)
                                        ),
                                        limit: 1,
                                    }))[0];
                                    const id = previous?.id ?? JSON.stringify([value.id, identity.userId]);
                                    yield* store.put("ExternalSessionConnection", {
                                        id,
                                        serviceInstance: value.id,
                                        userId: identity.userId,
                                        title: identity.title ?? identity.userId,
                                        status: "active",
                                        sessionId,
                                        expiresAt: identity.expiresAt,
                                    });
                                    return id;
                                })
                            );
                            return { connectionId: id };
                        }
                        case "disconnectApiKey":
                        case "forgetApiKey":
                            return yield* store.transaction(
                                Effect.gen(function* () {
                                    const current = yield* store.get(
                                        "ApiKeyConnection",
                                        text("connectionId")
                                    );
                                    if (!current && definition.name === "forgetApiKey") return;
                                    if (!current)
                                        return yield* connectError("NotFound", "Connection is unavailable.");
                                    if (current.apiKey)
                                        yield* options.values
                                            .evict(current.apiKey)
                                            .pipe(
                                                Effect.mapError(() =>
                                                    connectError(
                                                        "Storage",
                                                        "Credential deletion failed.",
                                                        true
                                                    )
                                                )
                                            );
                                    if (definition.name === "forgetApiKey")
                                        return yield* store.delete("ApiKeyConnection", current.id);
                                    yield* store.put("ApiKeyConnection", {
                                        ...current,
                                        apiKey: undefined,
                                        status: "inactive",
                                    });
                                })
                            );
                        case "disconnectExternalSession":
                        case "forgetExternalSession": {
                            const current = yield* store.transaction(
                                Effect.gen(function* () {
                                    const current = yield* store.get(
                                        "ExternalSessionConnection",
                                        text("connectionId")
                                    );
                                    if (!current && definition.name === "forgetExternalSession") return;
                                    if (!current)
                                        return yield* connectError("NotFound", "Connection is unavailable.");
                                    if (definition.name === "forgetExternalSession")
                                        yield* store.delete("ExternalSessionConnection", current.id);
                                    else
                                        yield* store.put("ExternalSessionConnection", {
                                            ...current,
                                            status: "inactive",
                                        });
                                    return current;
                                })
                            );
                            if (!current) return;
                            // Detach first. Failed remote revocation cannot restore local access.
                            const { value, service } = yield* instance(current.serviceInstance);
                            yield* (
                                service.disconnectExternalSession?.({
                                    serviceInstance: value,
                                    sessionId: current.sessionId,
                                }) ?? Effect.void
                            );
                            return;
                        }
                        default:
                            return yield* new BackendError({
                                operation: "applyAction",
                                kind: "NotImplemented",
                                retryable: false,
                                actionOutcome: "not-committed",
                                message: "Connect action has no implementation.",
                            });
                    }
                }).pipe(
                    Effect.mapError((error) =>
                        error instanceof BackendError ? error : connectBackendError(error)
                    )
                );
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
        yield* maintainConnect(backend.maintenance!, options.maintenance);
        return { backend, connect, store };
    },
    Effect.mapError((error) => (error instanceof BackendError ? error : connectBackendError(error)))
);
