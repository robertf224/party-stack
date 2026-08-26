import { unauthenticated } from "@party-stack/errors";
import {
    createLocalCollection,
    isCoordinationHost,
    type CoordinationServiceServer,
} from "@party-stack/runtime";
import * as oauth from "oauth4webapi";
import { resolveOAuthSecretStore } from "./storage.js";
import type {
    CreatePublicOAuthClientOptions,
    OAuthSession,
    PublicOAuthClient,
} from "./types.js";

interface PendingAuthorization {
    state: string;
    secretKey: string;
    createdAt: number;
}

interface PendingSecret {
    codeVerifier: string;
}

interface SessionRecord {
    userId: string;
    secretKey: string;
    createdAt?: number;
}

interface StoredTokenSet {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    scope?: string;
}

const PENDING_MAX_AGE_MS = 10 * 60 * 1_000;

interface OAuthCoordinationService {
    methods: {
        refresh(input: {
            userId: string;
        }): Promise<OAuthSession>;
    };
    events: Record<never, never>;
}

function sessionFromTokens(
    userId: string,
    tokens: StoredTokenSet
): OAuthSession {
    return tokens.expiresAt === undefined
        ? { userId }
        : {
              userId,
              expiration: {
                  expiresAt: tokens.expiresAt,
                  refreshable:
                      tokens.refreshToken !==
                      undefined,
              },
          };
}

export async function createPublicOAuthClient(
    options: CreatePublicOAuthClientOptions
): Promise<PublicOAuthClient> {
    const secrets = await resolveOAuthSecretStore(options);
    const storagePrefix = `oauth:${encodeURIComponent(options.clientId)}`;
    const refreshCoordination =
        options.runtime.coordination.service<OAuthCoordinationService>(
            `${storagePrefix}:refresh:v1`
        );
    const pending = createLocalCollection<
        PendingAuthorization,
        string
    >({
        name: `${storagePrefix}:pending`,
        getKey: (record) => record.state,
        runtime: options.runtime,
        schemaVersion: 1,
    });
    const sessions = createLocalCollection<
        SessionRecord,
        string
    >({
        name: `${storagePrefix}:sessions`,
        getKey: (record) => record.userId,
        runtime: options.runtime,
        schemaVersion: 1,
    });
    await Promise.all([
        pending.preload(),
        sessions.preload(),
    ]);

    const authorizationServer: oauth.AuthorizationServer = {
        issuer: options.authorizationServer.issuer,
        authorization_endpoint:
            options.authorizationServer
                .authorizationEndpoint,
        token_endpoint:
            options.authorizationServer.tokenEndpoint,
        revocation_endpoint:
            options.authorizationServer
                .revocationEndpoint,
    };
    const client: oauth.Client = {
        client_id: options.clientId,
        token_endpoint_auth_method: "none",
    };
    const clientAuthentication = oauth.None();
    const requestOptions = {
        [oauth.customFetch]:
            options.fetch ??
            globalThis.fetch.bind(globalThis),
    };
    const accessTokens = new Map<
        string,
        StoredTokenSet
    >();
    let cleaned = false;

    const pendingSecretKey = (state: string) =>
        `${storagePrefix}:pending:${state}`;
    const sessionSecretKey = (userId: string) =>
        `${storagePrefix}:session:${encodeURIComponent(userId)}`;

    const writeSession = async (
        tokens: StoredTokenSet,
        expectedUserId?: string
    ): Promise<OAuthSession> => {
        const resolvedUserId = await options.resolveUserId(
            tokens.accessToken
        );
        if (
            expectedUserId &&
            resolvedUserId !== expectedUserId
        ) {
            throw new Error(
                `OAuth refresh changed user from "${expectedUserId}" to "${resolvedUserId}".`
            );
        }
        const userId = expectedUserId ?? resolvedUserId;
        const secretKey = sessionSecretKey(userId);
        const existing = sessions.get(userId);
        if (!existing) {
            const transaction = sessions.insert(
                {
                    userId,
                    secretKey,
                    createdAt: Date.now(),
                },
                { optimistic: false }
            );
            await transaction.isPersisted.promise;
        }
        try {
            await secrets.set(
                secretKey,
                JSON.stringify(tokens)
            );
        } catch (error) {
            if (!existing && sessions.get(userId)) {
                await sessions.delete(userId, {
                    optimistic: false,
                }).isPersisted.promise;
            }
            throw error;
        }
        accessTokens.set(userId, tokens);
        return sessionFromTokens(userId, tokens);
    };

    const readTokens = async (
        record: SessionRecord,
        force = false
    ): Promise<StoredTokenSet | undefined> => {
        const loaded = accessTokens.get(record.userId);
        if (loaded && !force) return loaded;
        const stored = await secrets.get(record.secretKey);
        if (!stored) return;
        const tokens = JSON.parse(stored) as StoredTokenSet;
        accessTokens.set(record.userId, tokens);
        return tokens;
    };
    const forgetSession = async (
        userId: string
    ): Promise<void> => {
        const record = sessions.get(userId);
        if (!record) return;
        await secrets.delete(record.secretKey);
        await sessions.delete(userId, {
            optimistic: false,
        }).isPersisted.promise;
        accessTokens.delete(userId);
    };

    const removePending = async (
        state: string,
        secretKey: string
    ) => {
        await secrets.delete(secretKey);
        if (!pending.get(state)) return;
        const transaction = pending.delete(state, {
            optimistic: false,
        });
        await transaction.isPersisted.promise;
    };
    const cleanupStalePending = async () => {
        const cutoff =
            Date.now() - PENDING_MAX_AGE_MS;
        await Promise.all(
            [...pending.values()]
                .filter(
                    (record) =>
                        record.createdAt < cutoff
                )
                .map((record) =>
                    removePending(
                        record.state,
                        record.secretKey
                    )
                )
        );
    };

    const completeAuthorization = async (
        callbackUrl: string
    ): Promise<OAuthSession> => {
        const callback = new URL(callbackUrl);
        const state = callback.searchParams.get("state");
        if (!state) {
            throw new Error(
                "OAuth callback did not include state."
            );
        }
        const pendingRecord = pending.get(state);
        if (!pendingRecord) {
            throw new Error(
                "OAuth callback state is not recognized."
            );
        }
        const serialized = await secrets.get(
            pendingRecord.secretKey
        );
        if (!serialized) {
            throw new Error(
                "OAuth callback secret state is unavailable."
            );
        }
        const pendingSecret = JSON.parse(
            serialized
        ) as PendingSecret;
        try {
            const parameters = oauth.validateAuthResponse(
                authorizationServer,
                client,
                callback.searchParams,
                state
            );
            const response =
                await oauth.authorizationCodeGrantRequest(
                    authorizationServer,
                    client,
                    clientAuthentication,
                    parameters,
                    options.redirectUrl,
                    pendingSecret.codeVerifier,
                    requestOptions
                );
            const result =
                await oauth.processAuthorizationCodeResponse(
                    authorizationServer,
                    client,
                    response
                );
            return writeSession({
                accessToken: result.access_token,
                refreshToken: result.refresh_token,
                expiresAt:
                    result.expires_in === undefined
                        ? undefined
                        : Date.now() +
                          result.expires_in * 1_000,
                scope: result.scope,
            });
        } finally {
            await removePending(
                state,
                pendingRecord.secretKey
            );
        }
    };

    const refreshDirect = async (
        userId: string
    ): Promise<OAuthSession> => {
        const record = sessions.get(userId);
        if (!record) {
            throw new Error(
                `OAuth session for user "${userId}" is unavailable.`
            );
        }
        const current = await readTokens(record);
        if (!current?.refreshToken) {
            throw new Error(
                `OAuth session for user "${userId}" has no refresh token.`
            );
        }
        try {
            const response =
                await oauth.refreshTokenGrantRequest(
                    authorizationServer,
                    client,
                    clientAuthentication,
                    current.refreshToken,
                    requestOptions
                );
            const result =
                await oauth.processRefreshTokenResponse(
                    authorizationServer,
                    client,
                    response
                );
            return writeSession(
                {
                    accessToken: result.access_token,
                    refreshToken:
                        result.refresh_token ??
                        current.refreshToken,
                    expiresAt:
                        result.expires_in ===
                        undefined
                            ? undefined
                            : Date.now() +
                              result.expires_in *
                                  1_000,
                    scope:
                        result.scope ??
                        current.scope,
                },
                userId
            );
        } catch (error) {
            if (
                error instanceof
                    oauth.ResponseBodyError &&
                (error.error ===
                    "invalid_grant" ||
                    error.error ===
                        "invalid_token")
            ) {
                await forgetSession(userId);
                throw unauthenticated(
                    error.error_description ??
                        "OAuth credentials require authentication."
                );
            }
            throw error;
        }
    };

    const host = isCoordinationHost(
        options.runtime.coordination
    )
        ? options.runtime.coordination
        : undefined;
    const refreshServer:
        | CoordinationServiceServer<OAuthCoordinationService>
        | undefined = host
        ? host.serve<OAuthCoordinationService>(
              `${storagePrefix}:refresh:v1`,
              {
                  refresh: ({ userId }) =>
                      refreshDirect(userId),
              }
          )
        : undefined;

    const refresh = async (
        userId: string
    ): Promise<OAuthSession> => {
        let session: OAuthSession;
        try {
            session =
                await refreshCoordination.methods.refresh(
                    {
                        userId,
                    }
                );
        } catch (error) {
            if (
                error instanceof Error &&
                error.name ===
                    "UnauthenticatedError"
            ) {
                throw unauthenticated(
                    error.message
                );
            }
            throw error;
        }
        accessTokens.delete(userId);
        const record = sessions.get(userId);
        if (record) {
            await readTokens(record, true);
        }
        return session;
    };

    const clientApi: PublicOAuthClient = {
        async signIn(signInOptions = {}) {
            const browserAuthentication =
                options.runtime
                    .browserAuthentication;
            if (!browserAuthentication) {
                throw new Error(
                    "Interactive OAuth requires RuntimeAdapter.browserAuthentication."
                );
            }
            const browserSession =
                browserAuthentication.start({
                    redirectUrl:
                        options.redirectUrl,
                    presentation:
                        signInOptions.browserPresentation,
                });
            const state = oauth.generateRandomState();
            const secretKey = pendingSecretKey(state);
            try {
                await cleanupStalePending();
                const codeVerifier =
                    oauth.generateRandomCodeVerifier();
                const codeChallenge =
                    await oauth.calculatePKCECodeChallenge(
                        codeVerifier
                    );
                const transaction = pending.insert(
                    {
                        state,
                        secretKey,
                        createdAt: Date.now(),
                    },
                    { optimistic: false }
                );
                await transaction.isPersisted.promise;
                await secrets.set(
                    secretKey,
                    JSON.stringify(
                        { codeVerifier } satisfies PendingSecret
                    )
                );
                const authorizationUrl = new URL(
                    options.authorizationServer
                        .authorizationEndpoint
                );
                authorizationUrl.search =
                    new URLSearchParams({
                        client_id: options.clientId,
                        redirect_uri:
                            options.redirectUrl,
                        response_type: "code",
                        scope: options.scopes.join(" "),
                        state,
                        code_challenge:
                            codeChallenge,
                        code_challenge_method:
                            "S256",
                    }).toString();
                const { callbackUrl } =
                    await browserSession.open(
                        authorizationUrl.toString()
                    );
                return completeAuthorization(
                    callbackUrl
                );
            } catch (error) {
                await removePending(
                    state,
                    secretKey
                );
                await browserSession.close();
                throw error;
            }
        },
        completeRedirect(url) {
            const state = new URL(
                url
            ).searchParams.get("state");
            if (!state || !pending.get(state)) {
                return Promise.resolve(undefined);
            }
            return completeAuthorization(url);
        },
        async restoreSessions() {
            await cleanupStalePending();
            const restored = new Map<
                string,
                OAuthSession
            >();
            for (const record of sessions.values()) {
                if (restored.has(record.userId)) continue;
                const tokens = await readTokens(record);
                if (!tokens) {
                    if (
                        (record.createdAt ?? 0) <
                        Date.now() -
                            PENDING_MAX_AGE_MS
                    ) {
                        await sessions.delete(
                            record.userId,
                            {
                                optimistic: false,
                            }
                        ).isPersisted.promise;
                    }
                    continue;
                }
                restored.set(
                    record.userId,
                    sessionFromTokens(
                        record.userId,
                        tokens
                    )
                );
            }
            return [...restored.values()];
        },
        refresh,
        async getAccessToken(userId) {
            const record = sessions.get(userId);
            if (!record) {
                throw new Error(
                    `OAuth session for user "${userId}" is unavailable.`
                );
            }
            let tokens = await readTokens(record);
            if (!tokens) {
                throw new Error(
                    `OAuth tokens for user "${userId}" are unavailable.`
                );
            }
            if (
                tokens.expiresAt !== undefined &&
                tokens.expiresAt <= Date.now() + 5_000
            ) {
                tokens =
                    (await readTokens(
                        record,
                        true
                    )) ?? tokens;
                if (
                    tokens.expiresAt !==
                        undefined &&
                    tokens.expiresAt <=
                        Date.now() + 5_000
                ) {
                    await refresh(userId);
                    tokens =
                        accessTokens.get(userId)!;
                }
            }
            return tokens.accessToken;
        },
        async revoke(userId) {
            const record = sessions.get(userId);
            if (!record) return;
            const tokens = await readTokens(record);
            if (
                tokens &&
                options.authorizationServer
                    .revocationEndpoint
            ) {
                const response = await oauth.revocationRequest(
                    authorizationServer,
                    client,
                    clientAuthentication,
                    tokens.refreshToken ??
                        tokens.accessToken,
                    requestOptions
                );
                await oauth.processRevocationResponse(response);
            }
            await forgetSession(userId);
        },
        async cleanup() {
            if (cleaned) return;
            cleaned = true;
            accessTokens.clear();
            await Promise.all([
                refreshServer?.close(),
                pending.cleanup(),
                sessions.cleanup(),
                secrets.cleanup(),
            ]);
        },
    };
    return clientApi;
}
