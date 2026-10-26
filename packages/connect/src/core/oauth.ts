import { Clock, Effect, Redacted } from "effect";
import * as oauth from "oauth4webapi";
import { Temporal } from "temporal-polyfill";
import { connectError } from "./errors.js";
import type { ConnectOAuthProvider, OAuthTokens } from "./Connect.js";

export interface OAuthProviderOptions {
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    revocationEndpoint?: string;
    clientId: string;
    clientAuthentication:
        | { method: "none" }
        | {
              method: "client_secret_basic" | "client_secret_post";
              secret: string | Redacted.Redacted<string>;
          };
    scopes: readonly string[];
    resolveSubject(accessToken: string): Effect.Effect<string, import("./errors.js").ConnectError>;
    /** Provider-specific metadata, when refresh expiration is actually reported. */
    refreshTokenExpiry?(
        response: oauth.TokenEndpointResponse,
        receivedAt: number
    ): Temporal.Instant | undefined;
    fetch?: typeof globalThis.fetch;
}

export function makeOAuthProvider(options: OAuthProviderOptions): ConnectOAuthProvider {
    const server: oauth.AuthorizationServer = {
        issuer: options.issuer,
        authorization_endpoint: options.authorizationEndpoint,
        token_endpoint: options.tokenEndpoint,
        revocation_endpoint: options.revocationEndpoint,
    };
    const client: oauth.Client = { client_id: options.clientId };
    const auth =
        options.clientAuthentication.method === "none"
            ? oauth.None()
            : options.clientAuthentication.method === "client_secret_basic"
              ? oauth.ClientSecretBasic(
                    Redacted.isRedacted(options.clientAuthentication.secret)
                        ? Redacted.value(options.clientAuthentication.secret)
                        : options.clientAuthentication.secret
                )
              : oauth.ClientSecretPost(
                    Redacted.isRedacted(options.clientAuthentication.secret)
                        ? Redacted.value(options.clientAuthentication.secret)
                        : options.clientAuthentication.secret
                );
    const requestOptions = (signal: AbortSignal) => ({
        signal,
        [oauth.customFetch]: options.fetch ?? globalThis.fetch.bind(globalThis),
    });
    const request = (
        run: (signal: AbortSignal) => Promise<oauth.TokenEndpointResponse>,
        refreshing = false
    ) =>
        Effect.gen(function* () {
            const result = yield* Effect.tryPromise({
                try: run,
                catch: (error) =>
                    error instanceof oauth.ResponseBodyError &&
                    ["invalid_grant", "invalid_token", "invalid_client"].includes(error.error)
                        ? connectError("NeedsAuthentication", "Provider credentials require authentication.")
                        : refreshing && !(error instanceof oauth.ResponseBodyError)
                          ? connectError(
                                "NeedsAuthentication",
                                "Refresh outcome is unknown; reconnect before retrying."
                            )
                          : connectError(
                                "Provider",
                                "OAuth provider request failed.",
                                error instanceof oauth.ResponseBodyError && error.status >= 500
                            ),
            });
            const now = yield* Clock.currentTimeMillis;
            const providerSubjectId = yield* options
                .resolveSubject(result.access_token)
                .pipe(
                    Effect.mapError((error) =>
                        refreshing
                            ? connectError(
                                  "NeedsAuthentication",
                                  "Could not verify refreshed credentials; reconnect before retrying."
                              )
                            : error
                    )
                );
            return {
                accessToken: result.access_token,
                accessTokenExpiresAt:
                    result.expires_in === undefined
                        ? undefined
                        : Temporal.Instant.fromEpochMilliseconds(now + result.expires_in * 1000),
                refreshToken: result.refresh_token,
                refreshTokenExpiresAt: options.refreshTokenExpiry?.(result, now),
                grantedScopes: result.scope,
                providerSubjectId,
            } satisfies OAuthTokens;
        });
    return {
        authorizationUrl: (input) =>
            Effect.try({
                try: () => {
                    const url = new URL(options.authorizationEndpoint);
                    url.search = new URLSearchParams({
                        client_id: options.clientId,
                        response_type: "code",
                        redirect_uri: input.redirectUrl,
                        state: input.state,
                        code_challenge: input.codeChallenge,
                        code_challenge_method: "S256",
                        scope: options.scopes.join(" "),
                    }).toString();
                    return url.href;
                },
                catch: () => connectError("Configuration", "OAuth authorization endpoint is invalid."),
            }),
        exchange: (input) =>
            request(async (signal) => {
                const parameters = oauth.validateAuthResponse(
                    server,
                    client,
                    new URL(input.callbackUrl).searchParams,
                    input.state
                );
                const response = await oauth.authorizationCodeGrantRequest(
                    server,
                    client,
                    auth,
                    parameters,
                    input.redirectUrl,
                    input.codeVerifier,
                    requestOptions(signal)
                );
                return oauth.processAuthorizationCodeResponse(server, client, response);
            }),
        refresh: (token) =>
            request(async (signal) => {
                const response = await oauth.refreshTokenGrantRequest(
                    server,
                    client,
                    auth,
                    token,
                    requestOptions(signal)
                );
                return oauth.processRefreshTokenResponse(server, client, response);
            }, true),
        clientCredentials: request(async (signal) => {
            const response = await oauth.clientCredentialsGrantRequest(
                server,
                client,
                auth,
                { scope: options.scopes.join(" ") },
                requestOptions(signal)
            );
            return oauth.processClientCredentialsResponse(server, client, response);
        }),
        revoke: (token) =>
            Effect.tryPromise({
                try: async (signal) => {
                    if (!options.revocationEndpoint) return;
                    const response = await oauth.revocationRequest(
                        server,
                        client,
                        auth,
                        token,
                        requestOptions(signal)
                    );
                    await oauth.processRevocationResponse(response);
                },
                catch: () => connectError("Provider", "Provider token revocation failed.", true),
            }),
    };
}
