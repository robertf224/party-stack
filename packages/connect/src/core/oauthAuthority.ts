import { and, eq, field, lte, ne } from "@party-stack/ontology-storage";
import { Clock, Context, Effect, Layer, Schema, Redacted } from "effect";
import * as oauth4webapi from "oauth4webapi";
import { Temporal } from "temporal-polyfill";
import { connectError, type ConnectError } from "./errors.js";
import type {
    ServiceInstanceRecord,
    OAuthAuthorizationAttemptRecord,
    OAuthConnectionRecord,
    OAuthApplicationRecord,
} from "../spec/index.js";
import type { ConnectStore } from "./store.js";
import type { Encrypted } from "@party-stack/ontology-spec/values";

export interface OAuthTokens {
    accessToken: string;
    accessTokenExpiresAt?: Temporal.Instant;
    refreshToken?: string;
    refreshTokenExpiresAt?: Temporal.Instant;
    grantedScopes?: string;
    userId: string;
}
export interface ConnectOAuthService {
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
    applicationId: string;
    principalId?: string;
    redirectUrl: string;
    returnUrl?: string;
    connectionId?: string;
    /** Trusted application fields; reserved attempt fields always take precedence. */
    properties?: Record<string, unknown>;
}
export interface OAuthAuthorityService {
    connectionForApplication(
        applicationId: string
    ): Effect.Effect<OAuthConnectionRecord | undefined, ConnectError>;
    begin(input: BeginAuthorization): Effect.Effect<{ id: string; authorizationUrl: string }, ConnectError>;
    complete(input: {
        callbackUrl: string;
        principalId?: string;
    }): Effect.Effect<OAuthConnectionRecord, ConnectError>;
    clientCredentials(input: {
        applicationId: string;
        connectionId?: string;
        properties?: Record<string, unknown>;
    }): Effect.Effect<OAuthConnectionRecord, ConnectError>;
    refresh(connectionId: string): Effect.Effect<OAuthConnectionRecord, ConnectError>;
    disconnect(connectionId: string): Effect.Effect<void, ConnectError>;
    forget(connectionId: string): Effect.Effect<void, ConnectError>;
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
export interface OAuthAuthorityOptions {
    store: ConnectStore;
    values: ConnectCredentialValues;
    oauth(input: {
        application: OAuthApplicationRecord;
        serviceInstance: ServiceInstanceRecord;
    }): Effect.Effect<ConnectOAuthService, ConnectError>;
    /** Populate application ownership properties in the same commit as token storage. */
    connectionProperties?(
        attempt: OAuthAuthorizationAttemptRecord
    ): Effect.Effect<Record<string, unknown>, ConnectError>;
}
export class OAuthAuthority extends Context.Service<OAuthAuthority, OAuthAuthorityService>()(
    "@party-stack/connect/OAuthAuthority"
) {
    static readonly layer = (options: OAuthAuthorityOptions) =>
        Layer.effect(OAuthAuthority, makeOAuthAuthority(options));
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
export const makeOAuthAuthority = (options: OAuthAuthorityOptions): Effect.Effect<OAuthAuthorityService> =>
    Effect.sync(() => {
        const { store, values } = options;
        const read = Effect.fnUntraced(function* (id: string) {
            const record = yield* store.get("OAuthConnection", id);
            if (!record) return yield* connectError("NotFound", "Connection is unavailable.");
            return record;
        });
        const configured = Effect.fnUntraced(function* (id: string) {
            const application = yield* store.get("OAuthApplication", id);
            if (!application) return yield* connectError("NotFound", "OAuth application is unavailable.");
            const serviceInstance = yield* store.get("ServiceInstance", application.serviceInstance);
            if (!serviceInstance) return yield* connectError("NotFound", "Service instance is unavailable.");
            return { application, oauth: yield* options.oauth({ application, serviceInstance }) };
        });
        const decrypt = (value: Encrypted<string>) =>
            values.decrypt(Schema.String, value).pipe(
                Effect.map(Redacted.make),
                Effect.mapError(() => connectError("Storage", "Credential decryption failed."))
            );
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
            if (record.userId && record.userId !== tokens.userId)
                return yield* connectError(
                    "NeedsAuthentication",
                    "Provider identity changed; reconnect explicitly."
                );
            const next: OAuthConnectionRecord = {
                ...record,
                status: "active",
                userId: tokens.userId,
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
                const { application, oauth } = yield* configured(record.application);
                let tokens: OAuthTokens;
                if (application.flow === "client-credentials") tokens = yield* oauth.clientCredentials;
                else {
                    if (
                        !record.refreshToken ||
                        expired(record.refreshTokenExpiresAt, yield* Clock.currentTimeMillis)
                    )
                        return yield* connectError(
                            "NeedsAuthentication",
                            "Refresh credentials are unavailable or expired."
                        );
                    tokens = yield* oauth.refresh(Redacted.value(yield* decrypt(record.refreshToken)));
                    if (!tokens.refreshToken)
                        tokens = {
                            ...tokens,
                            refreshToken: Redacted.value(yield* decrypt(record.refreshToken)),
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
        return OAuthAuthority.of({
            connectionForApplication: Effect.fn("Connect.connectionForApplication")(function* (
                applicationId: string
            ) {
                const application = yield* store.get("OAuthApplication", applicationId);
                if (!application) return yield* connectError("NotFound", "OAuth application is unavailable.");
                if (!application.connection) return;
                const connection = yield* read(application.connection);
                if (connection.application !== applicationId)
                    return yield* connectError(
                        "Configuration",
                        "OAuth application points to a connection belonging to another application."
                    );
                return connection;
            }),
            begin: Effect.fn("Connect.begin")(function* (input: BeginAuthorization) {
                yield* guardUrl(input.redirectUrl);
                if (input.returnUrl) yield* guardUrl(input.returnUrl);
                const { application, oauth } = yield* configured(input.applicationId);
                if (application.redirectUrl && input.redirectUrl !== application.redirectUrl)
                    return yield* connectError(
                        "Forbidden",
                        "Redirect URL does not match the OAuth application."
                    );
                if (application.flow !== "authorization-code")
                    return yield* connectError(
                        "Configuration",
                        "This application does not support interactive authorization."
                    );
                const id = oauth4webapi.generateRandomState();
                const verifier = oauth4webapi.generateRandomCodeVerifier();
                const challenge = yield* Effect.tryPromise({
                    try: () => oauth4webapi.calculatePKCECodeChallenge(verifier),
                    catch: () => connectError("Configuration", "Could not generate PKCE challenge."),
                });
                const authorizationUrl = yield* oauth.authorizationUrl({
                    state: id,
                    codeChallenge: challenge,
                    redirectUrl: input.redirectUrl,
                });
                yield* guardUrl(authorizationUrl);
                yield* store.transaction(
                    Effect.gen(function* () {
                        if (input.connectionId) {
                            const previous = yield* read(input.connectionId);
                            if (previous.application !== input.applicationId)
                                return yield* connectError(
                                    "Forbidden",
                                    "Connection belongs to another application."
                                );
                            yield* busy(previous, true);
                        }
                        yield* store.put("OAuthAuthorizationAttempt", {
                            ...input.properties,
                            id,
                            application: input.applicationId,
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
                principalId?: string;
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
                if (attempt.status === "completed") {
                    if (!attempt.connectionId)
                        return yield* connectError(
                            "InvalidAttempt",
                            "Completed authorization has no connection."
                        );
                    return yield* read(attempt.connectionId);
                }
                const exchange = Effect.gen(function* () {
                    const { application, oauth } = yield* configured(attempt.application);
                    const tokens = yield* oauth.exchange({
                        callbackUrl: input.callbackUrl,
                        state: id,
                        redirectUrl: attempt.redirectUrl,
                        codeVerifier: Redacted.value(yield* decrypt(attempt.codeVerifier)),
                    });
                    const extra = options.connectionProperties
                        ? yield* options.connectionProperties(attempt)
                        : {};
                    return yield* store.transaction(
                        Effect.gen(function* () {
                            const claimed = yield* store.get("OAuthAuthorizationAttempt", id);
                            if (!claimed || claimed.status !== "exchanging")
                                return yield* connectError(
                                    "InvalidAttempt",
                                    "Authorization attempt is no longer available."
                                );
                            const requested = yield* store.get("OAuthConnection", attempt.connectionId);
                            const matches = requested
                                ? []
                                : yield* store.load("OAuthConnection", {
                                      where: and(
                                          eq(field("application"), attempt.application),
                                          eq(field("userId"), tokens.userId)
                                      ),
                                  });
                            // Trusted application ownership fields participate in reuse;
                            // two projects/principals can still keep separate bindings.
                            const reusable = matches.find((row) =>
                                Object.entries(extra).every(
                                    ([name, value]) =>
                                        JSON.stringify((row as Record<string, unknown>)[name]) ===
                                        JSON.stringify(value)
                                )
                            );
                            const connectionId = requested?.id ?? reusable?.id ?? attempt.connectionId;
                            const current = yield* store.get("OAuthConnection", connectionId);
                            if (current) {
                                if (current.application !== attempt.application)
                                    return yield* connectError(
                                        "Forbidden",
                                        "Connection belongs to another application."
                                    );
                            }
                            // A completed login supersedes an in-flight refresh. Clearing
                            // operationId fences its late result in finish().
                            const next = yield* saveTokens(
                                {
                                    ...extra,
                                    ...current,
                                    id: connectionId,
                                    application: attempt.application,
                                    title: current?.title ?? application.title,
                                    status: "active",
                                },
                                tokens
                            );
                            const latestConnector = yield* store.get("OAuthApplication", application.id);
                            if (!latestConnector)
                                return yield* connectError("NotFound", "OAuth application is unavailable.");
                            yield* store.put("OAuthApplication", { ...latestConnector, connection: next.id });
                            yield* store.put("OAuthAuthorizationAttempt", {
                                ...attempt,
                                connectionId: next.id,
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
                                    const claimed = yield* store.get("OAuthAuthorizationAttempt", id);
                                    if (!claimed || claimed.status !== "exchanging") return;
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
                applicationId: string;
                connectionId?: string;
                properties?: Record<string, unknown>;
            }) {
                const { application } = yield* configured(input.applicationId);
                if (application.flow !== "client-credentials")
                    return yield* connectError(
                        "Configuration",
                        "This application does not use client credentials."
                    );
                const connectionId = input.connectionId ?? application.connection ?? crypto.randomUUID();
                yield* store.transaction(
                    Effect.gen(function* () {
                        const existing = yield* store.get("OAuthConnection", connectionId);
                        if (existing && existing.application !== application.id)
                            return yield* connectError(
                                "Forbidden",
                                "Connection belongs to another application."
                            );
                        if (existing) yield* busy(existing);
                        yield* store.put("OAuthConnection", {
                            ...input.properties,
                            ...existing,
                            id: connectionId,
                            title: existing?.title ?? application.title,
                            application: application.id,
                            status: "active",
                        });
                        const latest = yield* store.get("OAuthApplication", application.id);
                        if (!latest)
                            return yield* connectError("NotFound", "OAuth application is unavailable.");
                        yield* store.put("OAuthApplication", { ...latest, connection: connectionId });
                    })
                );
                return yield* refresh(connectionId);
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
                    const { oauth } = yield* configured(record.current.application);
                    if (oauth.revoke) yield* oauth.revoke(Redacted.value(record.plaintext));
                }
            }),
            forget: Effect.fn("Connect.forget")(function* (id: string) {
                const removed = yield* store.transaction(
                    Effect.gen(function* () {
                        const current = yield* store.get("OAuthConnection", id);
                        const token = current?.refreshToken ?? current?.accessToken;
                        const plaintext = token
                            ? yield* decrypt(token).pipe(Effect.catch(() => Effect.succeed(undefined)))
                            : undefined;
                        const attempts = yield* store.load("OAuthAuthorizationAttempt", {
                            where: eq(field("connectionId"), id),
                        });
                        for (const attempt of attempts) {
                            yield* evict(attempt.codeVerifier);
                            yield* store.delete("OAuthAuthorizationAttempt", attempt.id);
                        }
                        const applications = yield* store.load("OAuthApplication", {
                            where: eq(field("connection"), id),
                        });
                        for (const application of applications)
                            yield* store.put("OAuthApplication", { ...application, connection: undefined });
                        if (current) {
                            yield* evict(current.accessToken);
                            yield* evict(current.refreshToken);
                            yield* store.delete("OAuthConnection", id);
                        }
                        return { current, plaintext };
                    })
                );
                // Local deletion commits before remote revocation, including when
                // revocation fails. Action reference validation remains at the boundary.
                if (removed.current && removed.plaintext) {
                    const { oauth } = yield* configured(removed.current.application);
                    if (oauth.revoke) yield* oauth.revoke(Redacted.value(removed.plaintext));
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
                        // External sessions can be extended upstream. Revalidate
                        // them on demand instead of declaring a cached expiry final.
                        const expiredConnections = yield* store.load("ApiKeyConnection", {
                            where: and(
                                eq(field("status"), "active"),
                                ne(field("expiresAt"), undefined),
                                lte(field("expiresAt"), now)
                            ),
                            orderBy: [{ field: field("expiresAt") }],
                            limit,
                        });
                        for (const record of expiredConnections)
                            yield* store.put("ApiKeyConnection", { ...record, status: "needs-auth" });
                        return { attempts: attempts.length, refreshTokens: connections.length };
                    })
                );
            }),
        });
    });
