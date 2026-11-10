import {
    ConnectError,
    makeOAuthService,
    toWebEgress,
    withHttpAuthenticationErrors,
    type ServiceConnector,
} from "@party-stack/connect";
import { createFoundryFetch, createFoundryWebSocket, getTokenDetails } from "@party-stack/foundry-client";
import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { Effect, Fiber, Schema } from "effect";
import { Temporal } from "temporal-polyfill";

/** Reusable integration; the saved ServiceInstance supplies the Foundry stack URL. */
export function makeFoundryServiceConnector(
    options: {
        readonly fetch?: typeof globalThis.fetch;
    } = {}
): ServiceConnector {
    const defaultScopes = [
        "api:use-ontologies-read",
        "api:use-ontologies-write",
        "api:use-mediasets-read",
        "api:use-mediasets-write",
        "offline_access",
    ];
    const identity = (token: string) =>
        Effect.try({
            try: () => getTokenDetails(token),
            catch: () =>
                new ConnectError({
                    kind: "NeedsAuthentication",
                    retryable: false,
                    message: "Foundry credentials are invalid.",
                }),
        });
    return {
        service: "foundry",
        displayName: "Foundry",
        defaultOAuthScopes: defaultScopes,
        oauth: Effect.fnUntraced(function* ({ application, serviceInstance, values }) {
            const base = serviceInstance.instanceUrl.replace(/\/$/, "");
            const secret = application.clientSecret
                ? yield* values.decrypt(Schema.String, application.clientSecret).pipe(
                      Effect.mapError(
                          () =>
                              new ConnectError({
                                  kind: "Storage",
                                  retryable: false,
                                  message: "OAuth client secret is unavailable.",
                              })
                      )
                  )
                : undefined;
            return makeOAuthService({
                issuer: `${base}/multipass/`,
                authorizationEndpoint: `${base}/multipass/api/oauth2/authorize`,
                tokenEndpoint: `${base}/multipass/api/oauth2/token`,
                revocationEndpoint: `${base}/multipass/api/oauth2/revoke_token`,
                clientId: application.clientId,
                clientAuthentication: secret ? { method: "client_secret_basic", secret } : { method: "none" },
                scopes: application.scopes ?? defaultScopes,
                fetch: options.fetch,
                resolveSubject: (token) => identity(token).pipe(Effect.map((value) => value.userId)),
            });
        }),
        apiKey: ({ apiKey }) =>
            identity(apiKey).pipe(
                Effect.map(({ userId, expiresAt }) => ({
                    userId,
                    expiresAt:
                        expiresAt === undefined
                            ? undefined
                            : Temporal.Instant.fromEpochMilliseconds(expiresAt),
                }))
            ),
        acquire: Effect.fnUntraced(function* ({ connection, serviceInstance, credential, handlers }) {
            if (connection.objectType === "ExternalSessionConnection")
                return yield* new BackendError({
                    operation: "foundry.acquire",
                    kind: "InvalidConfiguration",
                    retryable: false,
                    message: "Foundry requires an OAuth or API-key connection.",
                });
            const scope = yield* Effect.scope;
            const web = yield* toWebEgress(handlers);
            const run = Effect.runPromiseWith(yield* Effect.context<never>());
            const tokenProvider = () =>
                run(
                    Effect.acquireUseRelease(
                        Effect.forkIn(credential, scope, { startImmediately: true }),
                        Fiber.join,
                        Fiber.interrupt
                    )
                );
            const fetch = createFoundryFetch({
                baseUrl: serviceInstance.instanceUrl,
                tokenProvider,
                fetch: web.fetch,
            });
            const createWebSocket = createFoundryWebSocket({
                baseUrl: serviceInstance.instanceUrl,
                tokenProvider,
                createWebSocket: web.createWebSocket,
            });
            const checkTarget = (target: string | URL) =>
                Effect.try({
                    try: () => {
                        const url = new URL(target);
                        if (url.protocol === "wss:") url.protocol = "https:";
                        if (url.protocol === "ws:") url.protocol = "http:";
                        if (url.origin !== new URL(serviceInstance.instanceUrl).origin)
                            throw new BackendError({
                                operation: "foundry.egress",
                                kind: "Forbidden",
                                retryable: false,
                                message: "Foundry egress target is outside the configured instance.",
                            });
                    },
                    catch: (cause) => classifyBackendFailure("foundry.egress", cause),
                });
            return withHttpAuthenticationErrors({
                fetch: (request) =>
                    checkTarget(request.url).pipe(
                        Effect.andThen(
                            Effect.tryPromise({
                                try: (signal) =>
                                    fetch(
                                        new Request(request, {
                                            signal: AbortSignal.any([request.signal, signal]),
                                        })
                                    ),
                                catch: (cause) => classifyBackendFailure("foundry.egress", cause),
                            })
                        )
                    ),
                createWebSocket: (url, protocols) =>
                    checkTarget(url).pipe(
                        Effect.andThen(
                            Effect.tryPromise({
                                try: () => createWebSocket(url, protocols),
                                catch: (cause) => classifyBackendFailure("foundry.egress", cause),
                            })
                        )
                    ),
            });
        }),
    };
}
