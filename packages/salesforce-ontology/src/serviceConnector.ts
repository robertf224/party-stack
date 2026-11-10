import { ConnectError, makeOAuthService, withHttpAuthenticationErrors } from "@party-stack/connect";
import { BackendError } from "@party-stack/ontology-backend";
import { Effect, Schema } from "effect";
import type { ServiceConnector } from "@party-stack/connect";

export function makeSalesforceServiceConnector(
    options: {
        readonly loginUrl?: string;
        readonly fetch?: typeof globalThis.fetch;
    } = {}
): ServiceConnector {
    const subject = (base: string, token: string) =>
        Effect.gen(function* () {
            const response = yield* Effect.tryPromise({
                try: (signal) =>
                    (options.fetch ?? globalThis.fetch)(`${base}/services/oauth2/userinfo`, {
                        signal,
                        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
                    }),
                catch: () =>
                    new ConnectError({
                        kind: "Provider",
                        retryable: true,
                        message: "Salesforce identity request failed.",
                    }),
            });
            if (!response.ok)
                return yield* new ConnectError({
                    kind: response.status === 401 ? "NeedsAuthentication" : "Provider",
                    retryable: response.status >= 500 || response.status === 429,
                    message: "Salesforce identity is unavailable.",
                });
            const value = yield* Effect.tryPromise({
                try: () => response.json(),
                catch: () =>
                    new ConnectError({
                        kind: "Provider",
                        retryable: false,
                        message: "Salesforce identity response is invalid.",
                    }),
            });
            const identity = yield* Schema.decodeUnknownEffect(
                Schema.Struct({
                    user_id: Schema.optional(Schema.NonEmptyString),
                    sub: Schema.optional(Schema.NonEmptyString),
                })
            )(value).pipe(
                Effect.mapError(
                    () =>
                        new ConnectError({
                            kind: "Provider",
                            retryable: false,
                            message: "Salesforce identity response is invalid.",
                        })
                )
            );
            const id = identity.user_id ?? identity.sub;
            if (!id)
                return yield* new ConnectError({
                    kind: "Provider",
                    retryable: false,
                    message: "Salesforce identity has no user ID.",
                });
            return id;
        });
    return {
        service: "salesforce",
        displayName: "Salesforce",
        defaultOAuthScopes: ["api", "refresh_token", "openid"],
        oauth: Effect.fnUntraced(function* ({ application, serviceInstance, values }) {
            const base = (options.loginUrl ?? serviceInstance.instanceUrl).replace(/\/+$/, "");
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
                issuer: base,
                authorizationEndpoint: `${base}/services/oauth2/authorize`,
                tokenEndpoint: `${base}/services/oauth2/token`,
                revocationEndpoint: `${base}/services/oauth2/revoke`,
                clientId: application.clientId,
                clientAuthentication: secret ? { method: "client_secret_post", secret } : { method: "none" },
                scopes: application.scopes ?? ["api", "refresh_token", "openid"],
                fetch: options.fetch,
                resolveSubject: (token) => subject(base, token),
            });
        }),
        apiKey: ({ apiKey, serviceInstance }) =>
            subject((options.loginUrl ?? serviceInstance.instanceUrl).replace(/\/+$/, ""), apiKey).pipe(
                Effect.map((userId) => ({ userId }))
            ),
        acquire: Effect.fnUntraced(function* ({
            connection,
            serviceInstance,
            credential,
            refreshCredential,
            handlers,
        }) {
            if (connection.objectType === "ExternalSessionConnection")
                return yield* new BackendError({
                    operation: "salesforce.acquire",
                    kind: "InvalidConfiguration",
                    retryable: false,
                    message: "Salesforce requires an OAuth or API-key connection.",
                });
            return withHttpAuthenticationErrors({
                fetch: Effect.fnUntraced(function* (request: Request) {
                    if (new URL(request.url).origin !== new URL(serviceInstance.instanceUrl).origin)
                        return yield* new BackendError({
                            operation: "salesforce.egress",
                            kind: "InvalidRequest",
                            retryable: false,
                            message: "Salesforce egress target is outside the configured instance.",
                        });
                    const token = yield* credential;
                    // Salesforce can omit token lifetime. Preserve its one retry
                    // after a 401, with refresh owned by Connect's single authority.
                    const retry = connection.objectType === "OAuthConnection" ? request.clone() : undefined;
                    const send = (value: Request, accessToken: string) => {
                        const headers = new Headers(value.headers);
                        headers.set("Authorization", `Bearer ${accessToken}`);
                        return handlers.fetch(new Request(value, { headers }));
                    };
                    const response = yield* send(request, token);
                    if (response.status !== 401 || !retry) return response;
                    if (response.body)
                        yield* Effect.promise(() => response.body!.cancel()).pipe(Effect.ignoreCause);
                    return yield* send(retry, yield* refreshCredential(token));
                }),
                createWebSocket: () =>
                    Effect.fail(
                        new BackendError({
                            operation: "salesforce.egress",
                            kind: "NotImplemented",
                            retryable: false,
                            message: "Salesforce WebSocket egress is not implemented.",
                        })
                    ),
            });
        }),
    };
}
