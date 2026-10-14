import type { OAuthSession } from "./types.js";

export interface CreateClientCredentialsOAuthClientOptions {
    clientId: string;
    clientSecret: string;
    tokenEndpoint: string;
    tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post";
    revocationEndpoint?: string;
    scopes?: readonly string[];
    resolveUserId(accessToken: string): string | Promise<string>;
    fetch?: typeof globalThis.fetch;
}

export interface ClientCredentialsOAuthClient {
    getAccessToken(): Promise<string>;
    getSession(): Promise<OAuthSession>;
    refresh(): Promise<OAuthSession>;
    revoke(): Promise<void>;
    cleanup(): void;
}

interface ClientCredentialsToken {
    accessToken: string;
    expiresAt?: number;
    scope?: string;
    userId: string;
}

export function createClientCredentialsOAuthClient(
    options: CreateClientCredentialsOAuthClientOptions
): ClientCredentialsOAuthClient {
    const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    let token: ClientCredentialsToken | undefined;
    let tokenRequest: Promise<ClientCredentialsToken> | undefined;
    let cleaned = false;
    const authMethod = options.tokenEndpointAuthMethod ?? "client_secret_post";

    const authenticatedRequest = (endpoint: string, parameters: URLSearchParams): Request => {
        const headers = new Headers({
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        });
        if (authMethod === "client_secret_basic") {
            headers.set(
                "Authorization",
                `Basic ${btoa(
                    `${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`
                )}`
            );
        } else {
            parameters.set("client_id", options.clientId);
            parameters.set("client_secret", options.clientSecret);
        }
        return new Request(endpoint, {
            method: "POST",
            headers,
            body: parameters,
        });
    };

    const requestToken = async (): Promise<ClientCredentialsToken> => {
        if (cleaned) {
            throw new Error("OAuth client has been cleaned up.");
        }
        const body = new URLSearchParams({
            grant_type: "client_credentials",
        });
        if (options.scopes?.length) {
            body.set("scope", options.scopes.join(" "));
        }
        const response = await fetchImpl(authenticatedRequest(options.tokenEndpoint, body));
        const result = (await response.json()) as {
            access_token?: unknown;
            error?: unknown;
            error_description?: unknown;
            expires_in?: unknown;
            scope?: unknown;
        };
        if (!response.ok || typeof result.access_token !== "string") {
            const message =
                typeof result.error_description === "string"
                    ? result.error_description
                    : typeof result.error === "string"
                      ? result.error
                      : `OAuth client credentials grant failed (${response.status}).`;
            throw new Error(message);
        }
        const userId = await options.resolveUserId(result.access_token);
        if (token && token.userId !== userId) {
            throw new Error(`OAuth client credentials changed user from "${token.userId}" to "${userId}".`);
        }
        return {
            accessToken: result.access_token,
            expiresAt:
                typeof result.expires_in === "number" ? Date.now() + result.expires_in * 1_000 : undefined,
            scope: typeof result.scope === "string" ? result.scope : undefined,
            userId,
        };
    };

    const refresh = async (): Promise<OAuthSession> => {
        tokenRequest ??= requestToken().finally(() => {
            tokenRequest = undefined;
        });
        token = await tokenRequest;
        return token.expiresAt === undefined
            ? { userId: token.userId }
            : {
                  userId: token.userId,
                  expiration: {
                      expiresAt: token.expiresAt,
                      refreshable: true,
                  },
              };
    };

    return {
        async getAccessToken() {
            if (!token || (token.expiresAt !== undefined && token.expiresAt <= Date.now() + 5_000)) {
                await refresh();
            }
            return token!.accessToken;
        },
        async getSession() {
            if (!token) {
                return refresh();
            }
            return token.expiresAt === undefined
                ? { userId: token.userId }
                : {
                      userId: token.userId,
                      expiration: {
                          expiresAt: token.expiresAt,
                          refreshable: true,
                      },
                  };
        },
        refresh,
        async revoke() {
            const accessToken = token?.accessToken;
            token = undefined;
            if (!accessToken || !options.revocationEndpoint) {
                return;
            }
            const response = await fetchImpl(
                authenticatedRequest(
                    options.revocationEndpoint,
                    new URLSearchParams({
                        token: accessToken,
                        token_type_hint: "access_token",
                    })
                )
            );
            if (!response.ok) {
                throw new Error(`OAuth token revocation failed (${response.status}).`);
            }
        },
        cleanup() {
            cleaned = true;
            token = undefined;
        },
    };
}
