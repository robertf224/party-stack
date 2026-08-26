import { createConfidentialOauthClient } from "@osdk/oauth";
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
import { createFoundryFetch, createFoundryWebSocket, getTokenDetails } from "@party-stack/foundry-client";
import { createPublicOAuthClient, type OAuthSession, type PublicOAuthClient } from "@party-stack/oauth";
import type { BrowserAuthenticationPresentation } from "@party-stack/runtime";

export interface FoundryOAuthConnectionOptions {
    clientId: string;
    redirectUrl: string;
    scopes?: string[];
    fetch?: typeof globalThis.fetch;
    dangerouslyPersistSecrets?: boolean;
}

export interface FoundryClientCredentialsConnectionOptions {
    clientId: string;
    clientSecret: string;
    userId?: string;
    scopes?: string[];
    fetch?: typeof globalThis.fetch;
}

export interface CreateFoundryConnectionAdapterOptions {
    baseUrl: string;
    oauth?: FoundryOAuthConnectionOptions;
    clientCredentials?: FoundryClientCredentialsConnectionOptions;
    token?: string;
}

export interface FoundryAuthenticationClient {
    completeOAuthRedirect(url: string): Promise<Connection<"active"> | undefined>;
    signIn: {
        oauth(options?: {
            expectedUserId?: string;
            browserPresentation?: BrowserAuthenticationPresentation;
        }): Promise<Connection<"active">>;
        clientCredentials(options?: { expectedUserId?: string }): Promise<Connection<"active">>;
        apiToken(options?: { token?: string; expectedUserId?: string }): Promise<Connection<"active">>;
    };
}

const DEFAULT_SCOPES = [
    "api:use-ontologies-read",
    "api:use-ontologies-write",
    "api:use-mediasets-read",
    "api:use-mediasets-write",
];

type ConfidentialOauthClient = ReturnType<typeof createConfidentialOauthClient>;

function assertExpectedUser(connection: Connection<"active">, expectedUserId?: string): void {
    if (expectedUserId && connection.userId !== expectedUserId) {
        throw new Error(`Expected user "${expectedUserId}", but connected "${connection.userId}".`);
    }
}

function activeState(expiresAt: number | undefined, refreshable: boolean): Connection<"active">["state"] {
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

function createFoundryEgressWrapper(options: {
    tokenProvider: () => Promise<string>;
}): (handlers: ConnectionEgressHandlers) => ConnectionEgressHandlers {
    return (handlers) => {
        const fetch = createFoundryFetch({
            tokenProvider: options.tokenProvider,
            fetch: (input, init) => handlers.fetch(new Request(input, init)),
        });
        const createWebSocket = createFoundryWebSocket({
            tokenProvider: options.tokenProvider,
            createWebSocket: (url, protocols) => handlers.createWebSocket(url, protocols),
        });
        return withHttpAuthenticationErrorHandling(
            withHttpRetryHandling({
                fetch: (request) => fetch(request),
                createWebSocket,
            })
        );
    };
}

async function createFoundryConnectionAdapterInstance(
    options: CreateFoundryConnectionAdapterOptions,
    context: BackendConnectionAdapterContext
): Promise<BackendConnectionAdapter<FoundryAuthenticationClient>> {
    let tokenActive = Boolean(options.token);
    const publicOauth: PublicOAuthClient | undefined = options.oauth
        ? await createPublicOAuthClient({
              clientId: options.oauth.clientId,
              redirectUrl: options.oauth.redirectUrl,
              scopes: [...new Set(["offline_access", ...(options.oauth.scopes ?? DEFAULT_SCOPES)])],
              authorizationServer: {
                  issuer: new URL(
                      "multipass/",
                      options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`
                  ).toString(),
                  authorizationEndpoint: new URL(
                      "multipass/api/oauth2/authorize",
                      options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`
                  ).toString(),
                  tokenEndpoint: new URL(
                      "multipass/api/oauth2/token",
                      options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`
                  ).toString(),
                  revocationEndpoint: new URL(
                      "multipass/api/oauth2/revoke_token",
                      options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`
                  ).toString(),
              },
              runtime: context.runtime,
              fetch: options.oauth.fetch,
              dangerouslyPersistSecrets: options.oauth.dangerouslyPersistSecrets,
              resolveUserId: (token) => getTokenDetails(token).userId,
          })
        : undefined;
    const confidentialOauth: ConfidentialOauthClient | undefined = options.clientCredentials
        ? createConfidentialOauthClient(
              options.clientCredentials.clientId,
              options.clientCredentials.clientSecret,
              options.baseUrl,
              options.clientCredentials.scopes ?? DEFAULT_SCOPES,
              options.clientCredentials.fetch
          )
        : undefined;

    const createTokenSession = (candidate?: string): EstablishedConnection => {
        const token = candidate ?? options.token;
        if (!token) {
            throw new Error("Foundry API token connections are not configured.");
        }
        const { userId, expiresAt } = getTokenDetails(token);
        const connection: Connection<"active"> = {
            userId,
            state: activeState(expiresAt, false),
        };
        const session: ConnectionSession = {
            disconnect() {
                if (token === options.token) {
                    tokenActive = false;
                }
                return Promise.resolve();
            },
            egress: createFoundryEgressWrapper({
                tokenProvider: () => Promise.resolve(token),
            }),
        };
        return { connection, session };
    };

    const createConfidentialSession = async (
        oauth: ConfidentialOauthClient
    ): Promise<EstablishedConnection> => {
        const token = await oauth.signIn();
        const userId = options.clientCredentials?.userId ?? getTokenDetails(token.access_token).userId;
        const connection: Connection<"active"> = {
            userId,
            state: activeState(token.expires_at, true),
        };
        const session: ConnectionSession = {
            refresh: () => createConfidentialSession(oauth),
            disconnect: () => oauth.signOut(),
            egress: createFoundryEgressWrapper({
                tokenProvider: oauth,
            }),
            cleanup() {
                (
                    oauth as ConfidentialOauthClient & {
                        rmTimeout?(): void;
                    }
                ).rmTimeout?.();
            },
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
        const session: ConnectionSession = {
            async refresh() {
                if (!publicOauth) {
                    throw unauthenticated("Foundry public OAuth is not configured.");
                }
                return createPublicSession(await publicOauth.refresh(userId));
            },
            async disconnect() {
                await publicOauth?.revoke(userId);
            },
            egress: createFoundryEgressWrapper({
                tokenProvider: () => {
                    if (!publicOauth) {
                        throw unauthenticated("Foundry public OAuth is not configured.");
                    }
                    return publicOauth.getAccessToken(userId);
                },
            }),
        };
        return { connection, session };
    };

    return {
        name: "foundry",
        createAuthenticationClient(controller) {
            return {
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
                            throw new Error("Foundry public OAuth is not configured.");
                        }
                        const session = await publicOauth.signIn({
                            browserPresentation: authenticationOptions.browserPresentation,
                        });
                        const connectionSession = createPublicSession(session);
                        assertExpectedUser(
                            connectionSession.connection,
                            authenticationOptions.expectedUserId
                        );
                        await controller.connect(connectionSession);
                        return connectionSession.connection;
                    },
                    async clientCredentials(authenticationOptions = {}) {
                        if (!confidentialOauth) {
                            throw new Error("Foundry client credentials are not configured.");
                        }
                        if (typeof window !== "undefined") {
                            throw new Error("Foundry client credentials cannot run in a browser.");
                        }
                        const session = await createConfidentialSession(confidentialOauth);
                        assertExpectedUser(session.connection, authenticationOptions.expectedUserId);
                        await controller.connect(session);
                        return session.connection;
                    },
                    async apiToken(authenticationOptions = {}) {
                        const session = createTokenSession(authenticationOptions.token);
                        if (authenticationOptions.token === undefined && options.token) {
                            tokenActive = true;
                        }
                        assertExpectedUser(session.connection, authenticationOptions.expectedUserId);
                        await controller.connect(session);
                        return session.connection;
                    },
                },
            };
        },
        async restoreConnections() {
            const restored = new Map<string, EstablishedConnection>();
            if (tokenActive && options.token) {
                const session = createTokenSession();
                restored.set(session.connection.userId, session);
            }
            if (publicOauth) {
                for (const oauthSession of await publicOauth.restoreSessions()) {
                    const session = createPublicSession(oauthSession);
                    restored.set(session.connection.userId, session);
                }
            }
            if (confidentialOauth && typeof window === "undefined") {
                const session = await createConfidentialSession(confidentialOauth);
                restored.set(session.connection.userId, session);
            }
            return [...restored.values()];
        },
        async cleanup() {
            await publicOauth?.cleanup();
        },
    };
}

export function createFoundryConnectionAdapter(
    options: CreateFoundryConnectionAdapterOptions
): BackendConnectionAdapterProvider<FoundryAuthenticationClient> {
    return (context) => createFoundryConnectionAdapterInstance(options, context);
}
