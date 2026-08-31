import {
    type BackendConnectionAdapter,
    type BackendConnectionAdapterContext,
    type BackendConnectionAdapterProvider,
    type Connection,
    type ConnectionEgressHandlers,
    type ConnectionSession,
    type EstablishedConnection,
    withHttpAuthenticationErrorHandling,
    withHttpRetryHandling,
} from "@party-stack/connections";
import { unauthenticated } from "@party-stack/errors";
import { createPublicOAuthClient, type OAuthSession, type PublicOAuthClient } from "@party-stack/oauth";
import {
    createSalesforceClient,
    type SalesforceChangeEvent,
    type SalesforceChangeEventSubscription,
} from "@party-stack/salesforce-client";
import type { BrowserAuthenticationPresentation } from "@party-stack/runtime";

export interface SalesforceOAuthConnectionOptions {
    clientId: string;
    redirectUrl: string;
    loginUrl?: string;
    scopes?: string[];
    fetch?: typeof globalThis.fetch;
    dangerouslyPersistSecrets?: boolean;
}

export interface CreateSalesforceConnectionAdapterOptions {
    instanceUrl: string;
    apiVersion?: string;
    oauth?: SalesforceOAuthConnectionOptions;
    token?: string;
    userId?: string;
}

export interface SalesforceAuthenticationClient {
    completeOAuthRedirect(url: string): Promise<Connection<"active"> | undefined>;
    subscribeToChangeEvents(
        userId: string,
        sObjectName: string,
        listener: (event: SalesforceChangeEvent) => void
    ): Promise<SalesforceChangeEventSubscription>;
    signIn: {
        oauth(options?: {
            browserPresentation?: BrowserAuthenticationPresentation;
        }): Promise<Connection<"active">>;
        accessToken(options?: {
            token?: string;
            userId?: string;
        }): Promise<Connection<"active">>;
    };
}

interface SalesforceUserInfo {
    user_id?: string;
    sub?: string;
}

const DEFAULT_SCOPES = ["api", "refresh_token", "openid"];

function normalizeUrl(value: string): string {
    return value.replace(/\/+$/, "");
}

function activeState(
    expiresAt: number | undefined,
    refreshable: boolean
): Connection<"active">["state"] {
    return expiresAt === undefined
        ? { status: "active" }
        : {
              status: "active",
              expiration: {
                  expiresAt,
                  refreshable,
              },
          };
}

async function resolveSalesforceUserId(options: {
    loginUrl: string;
    token: string;
    fetch: typeof globalThis.fetch;
}): Promise<string> {
    const response = await options.fetch(`${options.loginUrl}/services/oauth2/userinfo`, {
        headers: {
            Authorization: `Bearer ${options.token}`,
            Accept: "application/json",
        },
    });
    if (response.status === 401) {
        throw unauthenticated("Salesforce access token is invalid or expired.");
    }
    if (!response.ok) {
        throw new Error(
            `Salesforce userinfo failed with status ${response.status}: ${await response.text()}`
        );
    }
    const user = (await response.json()) as SalesforceUserInfo;
    const userId = user.user_id ?? user.sub;
    if (!userId) {
        throw new Error("Salesforce userinfo did not return user_id or sub.");
    }
    return userId;
}

function assertSalesforceOrigin(request: Request, instanceUrl: string): void {
    const actual = new URL(request.url).origin;
    const expected = new URL(instanceUrl).origin;
    if (actual !== expected) {
        throw new Error(`Salesforce egress not allowed for origin "${actual}".`);
    }
}

function createSalesforceEgressWrapper(options: {
    instanceUrl: string;
    tokenProvider: () => Promise<string>;
    refresh?: () => Promise<void>;
}): (handlers: ConnectionEgressHandlers) => ConnectionEgressHandlers {
    return (handlers) =>
        withHttpAuthenticationErrorHandling(
            withHttpRetryHandling({
                ...handlers,
                async fetch(request) {
                    assertSalesforceOrigin(request, options.instanceUrl);
                    const retryRequest =
                        request.clone();
                    const send = async (
                        current: Request
                    ) => {
                        const headers = new Headers(
                            current.headers
                        );
                        headers.set(
                            "Authorization",
                            `Bearer ${await options.tokenProvider()}`
                        );
                        return handlers.fetch(
                            new Request(current, {
                                headers,
                            })
                        );
                    };
                    let response =
                        await send(request);
                    if (
                        response.status === 401 &&
                        options.refresh
                    ) {
                        await options.refresh();
                        response =
                            await send(retryRequest);
                    }
                    return response;
                },
            })
        );
}

async function createSalesforceConnectionAdapterInstance(
    options: CreateSalesforceConnectionAdapterOptions,
    context: BackendConnectionAdapterContext
): Promise<BackendConnectionAdapter<SalesforceAuthenticationClient>> {
    const instanceUrl = normalizeUrl(options.instanceUrl);
    const apiVersion = options.apiVersion ?? "65.0";
    const loginUrl = normalizeUrl(options.oauth?.loginUrl ?? instanceUrl);
    const fetchImpl = options.oauth?.fetch ?? globalThis.fetch.bind(globalThis);
    let tokenActive = Boolean(options.token);
    const tokenProviders = new Map<
        string,
        () => Promise<string>
    >();
    const publicOauth: PublicOAuthClient | undefined = options.oauth
        ? await createPublicOAuthClient({
              clientId: options.oauth.clientId,
              redirectUrl: options.oauth.redirectUrl,
              scopes: [...new Set(options.oauth.scopes ?? DEFAULT_SCOPES)],
              authorizationServer: {
                  issuer: loginUrl,
                  authorizationEndpoint: `${loginUrl}/services/oauth2/authorize`,
                  tokenEndpoint: `${loginUrl}/services/oauth2/token`,
                  revocationEndpoint: `${loginUrl}/services/oauth2/revoke`,
              },
              runtime: context.runtime,
              fetch: options.oauth.fetch,
              dangerouslyPersistSecrets: options.oauth.dangerouslyPersistSecrets,
              resolveUserId: (token) =>
                  resolveSalesforceUserId({
                      loginUrl,
                      token,
                      fetch: fetchImpl,
                  }),
          })
        : undefined;

    const createTokenSession = async (authenticationOptions: {
        token?: string;
        userId?: string;
    } = {}): Promise<EstablishedConnection> => {
        const token = authenticationOptions.token ?? options.token;
        if (!token) {
            throw new Error("Salesforce access-token connections are not configured.");
        }
        const userId =
            authenticationOptions.userId ??
            options.userId ??
            (await resolveSalesforceUserId({
                loginUrl,
                token,
                fetch: fetchImpl,
            }));
        const connection: Connection<"active"> = {
            userId,
            state: { status: "active" },
        };
        tokenProviders.set(userId, () =>
            Promise.resolve(token)
        );
        const session: ConnectionSession = {
            disconnect() {
                tokenProviders.delete(userId);
                if (token === options.token) {
                    tokenActive = false;
                }
                return Promise.resolve();
            },
            egress: createSalesforceEgressWrapper({
                instanceUrl,
                tokenProvider: () => Promise.resolve(token),
            }),
        };
        return { connection, session };
    };

    const createPublicSession = (oauthSession: OAuthSession): EstablishedConnection => {
        const userId = oauthSession.userId;
        const connection: Connection<"active"> = {
            userId,
            state: activeState(
                oauthSession.expiration?.expiresAt,
                oauthSession.expiration?.refreshable ?? false
            ),
        };
        const tokenProvider = () => {
            if (!publicOauth) {
                throw unauthenticated(
                    "Salesforce public OAuth is not configured."
                );
            }
            return publicOauth.getAccessToken(userId);
        };
        tokenProviders.set(userId, tokenProvider);
        const session: ConnectionSession = {
            async refresh() {
                if (!publicOauth) {
                    throw unauthenticated("Salesforce public OAuth is not configured.");
                }
                return createPublicSession(await publicOauth.refresh(userId));
            },
            async disconnect() {
                tokenProviders.delete(userId);
                await publicOauth?.revoke(userId);
            },
            egress: createSalesforceEgressWrapper({
                instanceUrl,
                tokenProvider,
                refresh: async () => {
                    if (!publicOauth) {
                        throw unauthenticated(
                            "Salesforce public OAuth is not configured."
                        );
                    }
                    await publicOauth.refresh(
                        userId
                    );
                },
            }),
        };
        return { connection, session };
    };

    return {
        name: "salesforce",
        createAuthenticationClient(controller) {
            return {
                async subscribeToChangeEvents(
                    userId,
                    sObjectName,
                    listener
                ) {
                    const tokenProvider =
                        tokenProviders.get(userId);
                    if (!tokenProvider) {
                        throw unauthenticated(
                            `Salesforce connection for user "${userId}" is unavailable.`
                        );
                    }
                    const client =
                        createSalesforceClient({
                            instanceUrl,
                            apiVersion,
                            tokenProvider,
                        });
                    return client.subscribeToChangeEvents(
                        sObjectName,
                        listener
                    );
                },
                async completeOAuthRedirect(url) {
                    if (!publicOauth) return;
                    const session = await publicOauth.completeRedirect(url);
                    if (!session) return;
                    const connectionSession = createPublicSession(session);
                    await controller.connect(connectionSession);
                    return connectionSession.connection;
                },
                signIn: {
                    async oauth(authenticationOptions = {}) {
                        if (!publicOauth) {
                            throw new Error("Salesforce public OAuth is not configured.");
                        }
                        const session = await publicOauth.signIn({
                            browserPresentation: authenticationOptions.browserPresentation,
                        });
                        const connectionSession = createPublicSession(session);
                        await controller.connect(connectionSession);
                        return connectionSession.connection;
                    },
                    async accessToken(authenticationOptions = {}) {
                        const connectionSession = await createTokenSession(authenticationOptions);
                        if (authenticationOptions.token === undefined && options.token) {
                            tokenActive = true;
                        }
                        await controller.connect(connectionSession);
                        return connectionSession.connection;
                    },
                },
            };
        },
        async restoreConnections() {
            const restored = new Map<string, EstablishedConnection>();
            if (tokenActive && options.token) {
                const session = await createTokenSession();
                restored.set(session.connection.userId, session);
            }
            if (publicOauth) {
                for (const oauthSession of await publicOauth.restoreSessions()) {
                    const session = createPublicSession(oauthSession);
                    restored.set(session.connection.userId, session);
                }
            }
            return [...restored.values()];
        },
        async cleanup() {
            tokenProviders.clear();
            await publicOauth?.cleanup();
        },
    };
}

export function createSalesforceConnectionAdapter(
    options: CreateSalesforceConnectionAdapterOptions
): BackendConnectionAdapterProvider<SalesforceAuthenticationClient> {
    return (context) => createSalesforceConnectionAdapterInstance(options, context);
}
