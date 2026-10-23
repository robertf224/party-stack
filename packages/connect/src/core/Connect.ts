import { and, eq, field, lte, ne } from "@party-stack/ontology-storage";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import * as oauth from "oauth4webapi";
import { Temporal } from "temporal-polyfill";
import { connectError, type ConnectError } from "./errors.js";
import type {
    InstallationRecord,
    OAuthAuthorizationAttemptRecord,
    OAuthConnectionRecord,
    OAuthConnectorRecord,
} from "../spec/index.js";
import type { ConnectStore } from "./store.js";
import type { Encrypted } from "@party-stack/ontology-spec/values";

export interface OAuthTokens {
    accessToken: string;
    accessTokenExpiresAt?: Temporal.Instant;
    refreshToken?: string;
    refreshTokenExpiresAt?: Temporal.Instant;
    grantedScopes?: string;
    providerSubjectId: string;
}
export interface ConnectOAuthProvider {
    authorizationUrl(input: {
        state: string;
        codeChallenge: string;
        redirectUrl: string;
    }): Effect.Effect<string, ConnectError>;
    exchange(input: {
        callbackUrl: string;
        state: string;
        codeVerifier: string;
        redirectUrl: string;
    }): Effect.Effect<OAuthTokens, ConnectError>;
    refresh(refreshToken: string): Effect.Effect<OAuthTokens, ConnectError>;
    clientCredentials: Effect.Effect<OAuthTokens, ConnectError>;
    revoke?(token: string): Effect.Effect<void, ConnectError>;
}
export interface BeginAuthorization {
    connectorId: string;
    principalId: string;
    redirectUrl: string;
    returnUrl?: string;
    connectionId?: string;
    /** Trusted application fields; reserved attempt fields always take precedence. */
    properties?: Record<string, unknown>;
}
export interface ConnectService {
    connectionForConnector(
        connectorId: string
    ): Effect.Effect<OAuthConnectionRecord | undefined, ConnectError>;
    begin(input: BeginAuthorization): Effect.Effect<{ id: string; authorizationUrl: string }, ConnectError>;
    complete(input: {
        callbackUrl: string;
        principalId: string;
    }): Effect.Effect<OAuthConnectionRecord, ConnectError>;
    clientCredentials(input: {
        connectorId: string;
        connectionId?: string;
        properties?: Record<string, unknown>;
    }): Effect.Effect<OAuthConnectionRecord, ConnectError>;
    accessToken(connectionId: string): Effect.Effect<string, ConnectError>;
    refresh(connectionId: string): Effect.Effect<OAuthConnectionRecord, ConnectError>;
    disconnect(connectionId: string): Effect.Effect<void, ConnectError>;
    /** Indexed, bounded maintenance. Does not delete connection identities. */
    collectExpired(options?: {
        limit?: number;
    }): Effect.Effect<{ attempts: number; refreshTokens: number }, ConnectError>;
}
export interface ConnectCredentialValues {
    encrypt<A, AI>(schema: Schema.Codec<A, AI>, value: A): Effect.Effect<Encrypted<A>, unknown>;
    decrypt<A, AI>(schema: Schema.Codec<A, AI>, value: Encrypted<A>): Effect.Effect<A, unknown>;
    evict(value: Encrypted<unknown>): Effect.Effect<void, unknown>;
}
export interface ConnectOptions {
    store: ConnectStore;
    values: ConnectCredentialValues;
    provider(input: {
        connector: OAuthConnectorRecord;
        installation: InstallationRecord;
    }): Effect.Effect<ConnectOAuthProvider, ConnectError>;
    /** Populate application ownership properties in the same commit as token storage. */
    connectionProperties?(
        attempt: OAuthAuthorizationAttemptRecord
    ): Effect.Effect<Record<string, unknown>, ConnectError>;
}
export class Connect extends Context.Service<Connect, ConnectService>()("@party-stack/connect/Connect") {
    static readonly layer = (options: ConnectOptions) => Layer.effect(Connect, makeConnect(options));
}
const instant = (milliseconds: number) => Temporal.Instant.fromEpochMilliseconds(milliseconds);
const expired = (time: Temporal.Instant | undefined, now: number) =>
    time !== undefined && time.epochMilliseconds <= now;
const guardUrl = (value: string) =>
    Effect.try({
        try: () => {
            const url = new URL(value);
            if (
                url.protocol !== "https:" &&
                !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
            )
                throw new Error();
            return url;
        },
        catch: () => connectError("Configuration", "OAuth URLs require HTTPS (or HTTP on localhost)."),
    });

/** One credential authority, usable by both device and HTTP entry points. */
export const makeConnect = (options: ConnectOptions): Effect.Effect<ConnectService> =>
    Effect.sync(() => {
        const { store, values } = options;
        const read = Effect.fnUntraced(function* (id: string) {
            const record = yield* store.get("OAuthConnection", id);
            if (!record) return yield* connectError("NotFound", "Connection is unavailable.");
            return record;
        });
        const configured = Effect.fnUntraced(function* (id: string) {
            const connector = yield* store.get("OAuthConnector", id);
            if (!connector) return yield* connectError("NotFound", "Connector is unavailable.");
            const installation = yield* store.get("Installation", connector.installation);
            if (!installation) return yield* connectError("NotFound", "Installation is unavailable.");
            return { connector, provider: yield* options.provider({ connector, installation }) };
        });
        const decrypt = (value: Encrypted<string>) =>
            values
                .decrypt(Schema.String, value)
                .pipe(Effect.mapError(() => connectError("Storage", "Credential decryption failed.")));
        const encrypt = (value: string) =>
            values
                .encrypt(Schema.String, value)
                .pipe(Effect.mapError(() => connectError("Storage", "Credential encryption failed.")));
        const evict = (value: Encrypted<string> | undefined) =>
            value
                ? values
                      .evict(value)
                      .pipe(
                          Effect.mapError(() => connectError("Storage", "Credential deletion failed.", true))
                      )
                : Effect.void;
        const saveTokens = Effect.fnUntraced(function* (record: OAuthConnectionRecord, tokens: OAuthTokens) {
            if (record.providerSubjectId && record.providerSubjectId !== tokens.providerSubjectId)
                return yield* connectError(
                    "NeedsAuthentication",
                    "Provider identity changed; reconnect explicitly."
                );
            const next: OAuthConnectionRecord = {
                ...record,
                status: "active",
                providerSubjectId: tokens.providerSubjectId,
                accessToken: yield* encrypt(tokens.accessToken),
                accessTokenExpiresAt: tokens.accessTokenExpiresAt,
                refreshToken: tokens.refreshToken ? yield* encrypt(tokens.refreshToken) : undefined,
                refreshTokenExpiresAt: tokens.refreshToken ? tokens.refreshTokenExpiresAt : undefined,
                grantedScopes: tokens.grantedScopes,
                operationId: undefined,
                operationExpiresAt: undefined,
            };
            yield* store.put("OAuthConnection", next);
            yield* evict(record.accessToken);
            yield* evict(record.refreshToken);
            return next;
        });
        const busy = Effect.fnUntraced(function* (record: OAuthConnectionRecord, recovery = false) {
            if (!record.operationId) return;
            const now = yield* Clock.currentTimeMillis;
            if (!expired(record.operationExpiresAt, now))
                return yield* connectError("Busy", "Connection operation is in progress.", true);
            if (recovery) return;
            // A refresh may have rotated the token before its reply was lost. Never retry blindly.
            return yield* connectError(
                "NeedsAuthentication",
                "An interrupted credential operation requires reconnection."
            );
        });
        const finish = Effect.fnUntraced(function* (record: OAuthConnectionRecord, id: string) {
            const current = yield* read(record.id);
            if (current.operationId !== id)
                return yield* connectError("Busy", "Connection changed during the credential operation.");
            return current;
        });
        const refresh = Effect.fn("Connect.refresh")(function* (connectionId: string) {
            const operationId = crypto.randomUUID();
            const record = yield* store.transaction(
                Effect.gen(function* () {
                    const current = yield* read(connectionId);
                    yield* busy(current);
                    if (current.status !== "active")
                        return yield* connectError("NeedsAuthentication", "Reconnect this connection.");
                    const next = {
                        ...current,
                        operationId,
                        operationExpiresAt: instant((yield* Clock.currentTimeMillis) + 60_000),
                    };
                    yield* store.put("OAuthConnection", next);
                    return next;
                })
            );
            const request = Effect.gen(function* () {
                const { connector, provider } = yield* configured(record.connector);
                let tokens: OAuthTokens;
                if (connector.flow === "client-credentials") tokens = yield* provider.clientCredentials;
                else {
                    if (
                        !record.refreshToken ||
                        expired(record.refreshTokenExpiresAt, yield* Clock.currentTimeMillis)
                    )
                        return yield* connectError(
                            "NeedsAuthentication",
                            "Refresh credentials are unavailable or expired."
                        );
                    tokens = yield* provider.refresh(yield* decrypt(record.refreshToken));
                    if (!tokens.refreshToken)
                        tokens = {
                            ...tokens,
                            refreshToken: yield* decrypt(record.refreshToken),
                            refreshTokenExpiresAt: record.refreshTokenExpiresAt,
                        };
                }
                return yield* store.transaction(
                    Effect.gen(function* () {
                        const current = yield* finish(record, operationId);
                        return yield* saveTokens(current, tokens);
                    })
                );
            }).pipe(
                Effect.timeout(45_000),
                Effect.catchTag("TimeoutError", () =>
                    Effect.fail(
                        connectError(
                            "NeedsAuthentication",
                            "Credential exchange timed out; reconnect before retrying."
                        )
                    )
                )
            );
            return yield* request.pipe(
                Effect.catch((error) =>
                    store
                        .transaction(
                            Effect.gen(function* () {
                                const current = yield* finish(record, operationId);
                                if (error.kind === "NeedsAuthentication") {
                                    yield* evict(current.refreshToken);
                                    yield* store.put("OAuthConnection", {
                                        ...current,
                                        refreshToken: undefined,
                                        refreshTokenExpiresAt: undefined,
                                        status: "needs-auth",
                                        operationId: undefined,
                                        operationExpiresAt: undefined,
                                    });
                                } else if (error.kind !== "Storage")
                                    yield* store.put("OAuthConnection", {
                                        ...current,
                                        operationId: undefined,
                                        operationExpiresAt: undefined,
                                    });
                            })
                        )
                        .pipe(Effect.andThen(Effect.fail(error)))
                )
            );
        });
        return Connect.of({
            connectionForConnector: Effect.fn("Connect.connectionForConnector")(function* (
                connectorId: string
            ) {
                const connector = yield* store.get("OAuthConnector", connectorId);
                if (!connector) return yield* connectError("NotFound", "Connector is unavailable.");
                if (!connector.connection) return;
                const connection = yield* read(connector.connection);
                if (connection.connector !== connectorId)
                    return yield* connectError(
                        "Configuration",
                        "Connector points to a connection belonging to another connector."
                    );
                return connection;
            }),
            begin: Effect.fn("Connect.begin")(function* (input: BeginAuthorization) {
                yield* guardUrl(input.redirectUrl);
                if (input.returnUrl) yield* guardUrl(input.returnUrl);
                const { connector, provider } = yield* configured(input.connectorId);
                if (connector.flow !== "authorization-code")
                    return yield* connectError(
                        "Configuration",
                        "This connector does not support interactive authorization."
                    );
                const id = oauth.generateRandomState();
                const verifier = oauth.generateRandomCodeVerifier();
                const challenge = yield* Effect.tryPromise({
                    try: () => oauth.calculatePKCECodeChallenge(verifier),
                    catch: () => connectError("Configuration", "Could not generate PKCE challenge."),
                });
                const authorizationUrl = yield* provider.authorizationUrl({
                    state: id,
                    codeChallenge: challenge,
                    redirectUrl: input.redirectUrl,
                });
                yield* guardUrl(authorizationUrl);
                yield* store.transaction(
                    Effect.gen(function* () {
                        if (input.connectionId) {
                            const previous = yield* read(input.connectionId);
                            if (previous.connector !== input.connectorId)
                                return yield* connectError(
                                    "Forbidden",
                                    "Connection belongs to another connector."
                                );
                            yield* busy(previous, true);
                        }
                        yield* store.put("OAuthAuthorizationAttempt", {
                            ...input.properties,
                            id,
                            connector: input.connectorId,
                            principalId: input.principalId,
                            connectionId: input.connectionId ?? crypto.randomUUID(),
                            redirectUrl: input.redirectUrl,
                            returnUrl: input.returnUrl,
                            codeVerifier: yield* encrypt(verifier),
                            expiresAt: instant((yield* Clock.currentTimeMillis) + 600_000),
                            status: "pending",
                        });
                    })
                );
                return { id, authorizationUrl };
            }),
            complete: Effect.fn("Connect.complete")(function* (input: {
                callbackUrl: string;
                principalId: string;
            }) {
                const callback = yield* guardUrl(input.callbackUrl);
                const id = callback.searchParams.get("state");
                if (!id)
                    return yield* connectError("InvalidAttempt", "Authorization attempt is unavailable.");
                const attempt = yield* store.transaction(
                    Effect.gen(function* () {
                        const current = yield* store.get("OAuthAuthorizationAttempt", id);
                        if (
                            !current ||
                            current.principalId !== input.principalId ||
                            expired(current.expiresAt, yield* Clock.currentTimeMillis)
                        )
                            return yield* connectError(
                                "InvalidAttempt",
                                "Authorization attempt is unavailable."
                            );
                        const expected = new URL(current.redirectUrl);
                        if (expected.origin !== callback.origin || expected.pathname !== callback.pathname)
                            return yield* connectError(
                                "InvalidAttempt",
                                "Authorization callback URL does not match."
                            );
                        if (current.status === "completed") return current;
                        if (current.status !== "pending")
                            return yield* connectError(
                                "InvalidAttempt",
                                "Authorization attempt was already consumed; start again."
                            );
                        yield* store.put("OAuthAuthorizationAttempt", { ...current, status: "exchanging" });
                        return current;
                    })
                );
                if (attempt.status === "completed") return yield* read(attempt.connectionId);
                const exchange = Effect.gen(function* () {
                    const { connector, provider } = yield* configured(attempt.connector);
                    const tokens = yield* provider.exchange({
                        callbackUrl: input.callbackUrl,
                        state: id,
                        redirectUrl: attempt.redirectUrl,
                        codeVerifier: yield* decrypt(attempt.codeVerifier),
                    });
                    const extra = options.connectionProperties
                        ? yield* options.connectionProperties(attempt)
                        : {};
                    return yield* store.transaction(
                        Effect.gen(function* () {
                            const current = yield* store.get("OAuthConnection", attempt.connectionId);
                            if (current) {
                                if (current.connector !== attempt.connector)
                                    return yield* connectError(
                                        "Forbidden",
                                        "Connection belongs to another connector."
                                    );
                                yield* busy(current, true);
                            }
                            const next = yield* saveTokens(
                                {
                                    ...extra,
                                    ...current,
                                    id: attempt.connectionId,
                                    connector: attempt.connector,
                                    title: current?.title ?? connector.title,
                                    status: "active",
                                },
                                tokens
                            );
                            const latestConnector = yield* store.get("OAuthConnector", connector.id);
                            if (!latestConnector)
                                return yield* connectError("NotFound", "Connector is unavailable.");
                            yield* store.put("OAuthConnector", { ...latestConnector, connection: next.id });
                            yield* store.put("OAuthAuthorizationAttempt", {
                                ...attempt,
                                status: "completed",
                            });
                            yield* evict(attempt.codeVerifier);
                            return next;
                        })
                    );
                }).pipe(
                    Effect.timeout(45_000),
                    Effect.catchTag("TimeoutError", () =>
                        Effect.fail(
                            connectError("Provider", "Authorization exchange timed out; start again.")
                        )
                    )
                );
                return yield* exchange.pipe(
                    Effect.catch((error) =>
                        Effect.andThen(
                            store.transaction(
                                Effect.gen(function* () {
                                    yield* store.put("OAuthAuthorizationAttempt", {
                                        ...attempt,
                                        status: "failed",
                                    });
                                    yield* evict(attempt.codeVerifier);
                                })
                            ),
                            Effect.fail(error)
                        )
                    )
                );
            }),
            clientCredentials: Effect.fn("Connect.clientCredentials")(function* (input: {
                connectorId: string;
                connectionId?: string;
                properties?: Record<string, unknown>;
            }) {
                const { connector } = yield* configured(input.connectorId);
                if (connector.flow !== "client-credentials")
                    return yield* connectError(
                        "Configuration",
                        "This connector does not use client credentials."
                    );
                const connectionId = input.connectionId ?? connector.connection ?? crypto.randomUUID();
                yield* store.transaction(
                    Effect.gen(function* () {
                        const existing = yield* store.get("OAuthConnection", connectionId);
                        if (existing && existing.connector !== connector.id)
                            return yield* connectError(
                                "Forbidden",
                                "Connection belongs to another connector."
                            );
                        if (existing) yield* busy(existing);
                        yield* store.put("OAuthConnection", {
                            ...input.properties,
                            ...existing,
                            id: connectionId,
                            title: existing?.title ?? connector.title,
                            connector: connector.id,
                            status: "active",
                        });
                        const latest = yield* store.get("OAuthConnector", connector.id);
                        if (!latest) return yield* connectError("NotFound", "Connector is unavailable.");
                        yield* store.put("OAuthConnector", { ...latest, connection: connectionId });
                    })
                );
                return yield* refresh(connectionId);
            }),
            accessToken: Effect.fn("Connect.accessToken")(function* (id: string) {
                let current = yield* read(id);
                const now = yield* Clock.currentTimeMillis;
                // An expired refresh token need not invalidate a still-valid access token.
                if (
                    current.accessToken &&
                    !expired(current.accessTokenExpiresAt, now + 5_000) &&
                    current.status !== "inactive"
                )
                    return yield* decrypt(current.accessToken);
                current = yield* refresh(id);
                if (!current.accessToken)
                    return yield* connectError("NeedsAuthentication", "Access credentials are unavailable.");
                return yield* decrypt(current.accessToken);
            }),
            refresh,
            disconnect: Effect.fn("Connect.disconnect")(function* (id: string) {
                // Detach credentials atomically first. Revocation failure must not restore local access.
                const record = yield* store.transaction(
                    Effect.gen(function* () {
                        const current = yield* read(id);
                        const token = current.refreshToken ?? current.accessToken;
                        const plaintext = token
                            ? yield* decrypt(token).pipe(Effect.catch(() => Effect.succeed(undefined)))
                            : undefined;
                        yield* store.put("OAuthConnection", {
                            ...current,
                            status: "inactive",
                            operationId: undefined,
                            operationExpiresAt: undefined,
                            accessToken: undefined,
                            accessTokenExpiresAt: undefined,
                            refreshToken: undefined,
                            refreshTokenExpiresAt: undefined,
                        });
                        yield* evict(current.accessToken);
                        yield* evict(current.refreshToken);
                        return { current, plaintext };
                    })
                );
                if (record.plaintext) {
                    const { provider } = yield* configured(record.current.connector);
                    if (provider.revoke) yield* provider.revoke(record.plaintext);
                }
            }),
            collectExpired: Effect.fn("Connect.collectExpired")(function* ({
                limit = 100,
            }: { limit?: number } = {}) {
                if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
                    return yield* connectError("Configuration", "GC batch size must be between 1 and 1000.");
                return yield* store.transaction(
                    Effect.gen(function* () {
                        const now = instant(yield* Clock.currentTimeMillis);
                        const attempts = yield* store.load("OAuthAuthorizationAttempt", {
                            where: lte(field("expiresAt"), now),
                            orderBy: [{ field: field("expiresAt") }],
                            limit,
                        });
                        for (const attempt of attempts) {
                            yield* evict(attempt.codeVerifier);
                            yield* store.delete("OAuthAuthorizationAttempt", attempt.id);
                        }
                        const connections = yield* store.load("OAuthConnection", {
                            where: and(
                                ne(field("refreshTokenExpiresAt"), undefined),
                                lte(field("refreshTokenExpiresAt"), now),
                                eq(field("operationId"), undefined)
                            ),
                            orderBy: [{ field: field("refreshTokenExpiresAt") }],
                            limit,
                        });
                        for (const record of connections) {
                            yield* evict(record.refreshToken);
                            yield* store.put("OAuthConnection", {
                                ...record,
                                refreshToken: undefined,
                                refreshTokenExpiresAt: undefined,
                                status: "needs-auth",
                            });
                        }
                        return { attempts: attempts.length, refreshTokens: connections.length };
                    })
                );
            }),
        });
    });
