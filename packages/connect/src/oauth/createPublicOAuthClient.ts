import { unauthenticated } from "@party-stack/ontology-backend";
import { and, eq, field, ne } from "@party-stack/ontology-storage";
import { Runtime } from "@party-stack/runtime";
import { Clock, Effect, Exit, Fiber, Scope, Result, Schema } from "effect";
import { makeConnect } from "../core/Connect.js";
import { connectError, ConnectError } from "../core/errors.js";
import { maintainConnect } from "../core/maintenance.js";
import { makeOAuthProvider } from "../core/oauth.js";
import { makeConnectStore } from "../core/store.js";
import { runtimeCredentialValues } from "./storage.js";
import type { OAuthConnectionRecord } from "../spec/index.js";
import type {
    CreatePublicOAuthClientOptions,
    PublicOAuthClientOptions,
    OAuthSession,
    PublicOAuthClient,
} from "./types.js";

const session = (record: OAuthConnectionRecord): OAuthSession => ({
    userId: record.providerSubjectId!,
    expiration: record.accessTokenExpiresAt
        ? {
              expiresAt: record.accessTokenExpiresAt.epochMilliseconds,
              refreshable: record.refreshToken !== undefined,
          }
        : undefined,
});

/** Native acquisition. The caller's Scope owns OAuth requests, refresh work and PKCE state. */
export const makePublicOAuthClient = Effect.fn("PublicOAuthClient.make")(function* (
    options: PublicOAuthClientOptions
) {
    const owner = yield* Scope.fork(yield* Effect.scope);
    const context = yield* Effect.context<never>();
    const managed = { runPromise: Effect.runPromiseWith(context) };
    const close = () => Effect.runPromise(Scope.close(owner, Exit.void));
    return yield* Scope.provide(
        Effect.gen(function* () {
            const runtime = yield* Runtime;
            const namespace = JSON.stringify([
                "connect",
                runtime.owner,
                runtime.namespace,
                options.authorizationServer.issuer,
                options.clientId,
            ]);
            const values = yield* runtimeCredentialValues(runtime, namespace);
            const store = yield* makeConnectStore({ tables: runtime.tables, namespace });
            const installationId = options.authorizationServer.issuer;
            const connectorId = options.clientId;
            yield* store.transaction(
                Effect.gen(function* () {
                    if (!(yield* store.get("Installation", installationId)))
                        yield* store.put("Installation", {
                            id: installationId,
                            title: installationId,
                            providerId: "oauth",
                            instanceUrl: installationId,
                        });
                    if (!(yield* store.get("OAuthConnector", connectorId)))
                        yield* store.put("OAuthConnector", {
                            id: connectorId,
                            title: connectorId,
                            installation: installationId,
                            clientId: connectorId,
                            flow: "authorization-code",
                        });
                })
            );
            const provider = makeOAuthProvider({
                ...options.authorizationServer,
                clientId: options.clientId,
                clientAuthentication: { method: "none" },
                scopes: options.scopes,
                fetch: options.fetch,
                resolveSubject: (token) =>
                    Effect.tryPromise({
                        try: () => Promise.resolve(options.resolveUserId(token)),
                        catch: () => connectError("Provider", "Could not determine the provider identity."),
                    }),
            });
            const connect = yield* makeConnect({
                store,
                values,
                provider: () => Effect.succeed(provider),
            });
            const run = <A>(effect: Effect.Effect<A, ConnectError>) =>
                managed.runPromise(
                    Effect.flatMap(Effect.forkIn(effect, owner, { startImmediately: true }), Fiber.join).pipe(
                        Effect.catchTag("ConnectError", (error) =>
                            Effect.fail(
                                error.kind === "NeedsAuthentication" ? unauthenticated(error.message) : error
                            )
                        )
                    )
                );
            const find = Effect.fnUntraced(function* (userId: string) {
                const records = yield* store.load("OAuthConnection", {
                    where: and(
                        eq(field("connector"), connectorId),
                        eq(field("providerSubjectId"), userId),
                        ne(field("status"), "inactive")
                    ),
                });
                const currentConnector = yield* store.get("OAuthConnector", connectorId);
                const record =
                    records.find((candidate) => candidate.id === currentConnector?.connection) ?? records[0];
                if (!record)
                    return yield* connectError("NeedsAuthentication", "OAuth session is unavailable.");
                return record;
            });
            const complete = Effect.fn("Connect.browser.complete")(function* (url: string) {
                const state = new URL(url).searchParams.get("state");
                if (!state || !(yield* store.get("OAuthAuthorizationAttempt", state))) return;
                return session(yield* connect.complete({ callbackUrl: url, principalId: runtime.owner }));
            });
            yield* maintainConnect(connect).pipe(Effect.provideService(Scope.Scope, owner));
            const browser = runtime.browserAuthentication;
            return {
                beginAuthorization: () =>
                    run(
                        connect
                            .begin({
                                connectorId,
                                principalId: runtime.owner,
                                redirectUrl: options.redirectUrl,
                            })
                            .pipe(
                                Effect.map((started) => ({
                                    authorizationUrl: started.authorizationUrl,
                                    redirectUrl: options.redirectUrl,
                                }))
                            )
                    ),
                signIn: (signInOptions) =>
                    run(
                        Effect.gen(function* () {
                            if (!browser)
                                return yield* connectError(
                                    "Configuration",
                                    "Interactive OAuth requires a browser authentication capability."
                                );
                            // Open the popup synchronously in the initiating UI task where possible.
                            const presentation = yield* browser
                                .start({
                                    redirectUrl: options.redirectUrl,
                                    presentation: signInOptions?.browserPresentation,
                                })
                                .pipe(
                                    Effect.mapError((error) =>
                                        connectError(
                                            error.reason === "Configuration"
                                                ? "Configuration"
                                                : "InvalidAttempt",
                                            error.message
                                        )
                                    )
                                );
                            const started = yield* connect.begin({
                                connectorId,
                                principalId: runtime.owner,
                                redirectUrl: options.redirectUrl,
                            });
                            const { callbackUrl } = yield* presentation
                                .open(started.authorizationUrl)
                                .pipe(
                                    Effect.mapError(() =>
                                        connectError(
                                            "InvalidAttempt",
                                            "Browser authorization was cancelled or failed."
                                        )
                                    )
                                );
                            const established = yield* complete(callbackUrl);
                            if (!established)
                                return yield* connectError(
                                    "InvalidAttempt",
                                    "Authorization attempt is unavailable."
                                );
                            return established;
                        }).pipe(Effect.scoped)
                    ),
                completeRedirect: (url) => run(complete(url)),
                restoreSessions: () =>
                    run(
                        Effect.gen(function* () {
                            const records = yield* store.load("OAuthConnection", {
                                where: and(
                                    eq(field("connector"), connectorId),
                                    ne(field("status"), "inactive")
                                ),
                            });
                            const now = yield* Clock.currentTimeMillis;
                            const restored = new Map<string, OAuthSession>();
                            for (const record of records) {
                                if (
                                    !record.providerSubjectId ||
                                    (record.status !== "active" &&
                                        (!record.accessToken ||
                                            (record.accessTokenExpiresAt &&
                                                record.accessTokenExpiresAt.epochMilliseconds <= now)))
                                )
                                    continue;
                                const handle = record.refreshToken ?? record.accessToken;
                                if (!handle) continue;
                                const available = yield* Effect.result(values.decrypt(Schema.String, handle));
                                if (Result.isSuccess(available))
                                    restored.set(record.providerSubjectId, session(record));
                            }
                            return [...restored.values()];
                        })
                    ),
                refresh: (userId, options) =>
                    run(
                        Effect.gen(function* () {
                            const record = yield* find(userId);
                            // A different context may already have refreshed this shared record.
                            if (
                                options &&
                                record.accessToken &&
                                record.accessTokenExpiresAt &&
                                record.accessTokenExpiresAt.epochMilliseconds >
                                    (yield* Clock.currentTimeMillis) + options.ifExpiringWithinMs
                            )
                                return session(record);
                            return session(yield* connect.refresh(record.id));
                        })
                    ),
                getAccessToken: (userId) =>
                    run(
                        Effect.gen(function* () {
                            return yield* connect.accessToken((yield* find(userId)).id);
                        })
                    ),
                revoke: (userId) =>
                    run(
                        Effect.gen(function* () {
                            const records = yield* store.load("OAuthConnection", {
                                where: and(
                                    eq(field("connector"), connectorId),
                                    eq(field("providerSubjectId"), userId)
                                ),
                            });
                            for (const record of records) yield* connect.disconnect(record.id);
                        })
                    ),
                cleanup: close,
            } satisfies PublicOAuthClient;
        }),
        owner
    ).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(owner, exit) : Effect.void)));
});

/** SDK boundary for callers that explicitly supply the owning Scope. */
export const createPublicOAuthClient = (
    options: CreatePublicOAuthClientOptions
): Promise<PublicOAuthClient> =>
    Effect.runPromise(
        Scope.provide(
            makePublicOAuthClient(options).pipe(Effect.provideService(Runtime, options.runtime)),
            options.scope
        )
    );
