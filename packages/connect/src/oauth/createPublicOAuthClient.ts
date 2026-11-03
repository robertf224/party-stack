import { unauthenticated } from "@party-stack/ontology-backend";
import { backendQueryReader } from "@party-stack/ontology-backend/query";
import { and, eq, field, ne } from "@party-stack/ontology-storage";
import { Runtime } from "@party-stack/runtime";
import { Clock, Effect, Exit, Fiber, Scope, Result } from "effect";
import { connectionAccessToken } from "../core/accessToken.js";
import { makeConnectBackend } from "../core/backend.js";
import { connectError, ConnectError } from "../core/errors.js";
import { maintainConnect } from "../core/maintenance.js";
import { makeOAuthProvider } from "../core/oauth.js";
import { connectOntology } from "../spec/index.js";
import { runtimeCredentialValues } from "./storage.js";
import type { ConnectOntology, OAuthConnectionRecord } from "../spec/index.js";
import type {
    CreatePublicOAuthClientOptions,
    PublicOAuthClientOptions,
    OAuthSession,
    PublicOAuthClient,
} from "./types.js";
import type { BackendError } from "@party-stack/ontology-backend";
import type { Query } from "@party-stack/ontology-storage";

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
            const { backend, connect, store } = yield* makeConnectBackend({
                tables: runtime.tables,
                namespace,
                values,
                provider: () => Effect.succeed(provider),
            });

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
            const run = <A>(effect: Effect.Effect<A, ConnectError | BackendError>) =>
                managed.runPromise(
                    Effect.flatMap(Effect.forkIn(effect, owner, { startImmediately: true }), Fiber.join).pipe(
                        Effect.catchTag("ConnectError", (error) =>
                            Effect.fail(
                                error.kind === "NeedsAuthentication" ? unauthenticated(error.message) : error
                            )
                        )
                    )
                );
            const reader = backendQueryReader(connectOntology, backend);
            const load = <N extends keyof ConnectOntology["objectTypes"]>(name: N, query: Query) =>
                reader
                    .loadSubset(name, query)
                    .pipe(
                        Effect.map((rows) =>
                            rows.map((row) => row.value as ConnectOntology["objectTypes"][N])
                        )
                    );
            const get = <N extends keyof ConnectOntology["objectTypes"]>(name: N, id: string) =>
                load(name, { where: eq(field("id"), id) }).pipe(Effect.map((rows) => rows[0]));
            const apply = <N extends keyof ConnectOntology["actionTypes"]>(
                name: N,
                parameters: ConnectOntology["actionTypes"][N]["parameters"]
            ) =>
                backend
                    .applyAction({ id: crypto.randomUUID(), name, parameters })
                    .pipe(
                        Effect.map(
                            (receipt) => receipt.result as ConnectOntology["actionTypes"][N]["returnType"]
                        )
                    );
            const find = Effect.fnUntraced(function* (userId: string) {
                const records = yield* load("OAuthConnection", {
                    where: and(
                        eq(field("connector"), connectorId),
                        eq(field("providerSubjectId"), userId),
                        ne(field("status"), "inactive")
                    ),
                });
                const currentConnector = yield* get("OAuthConnector", connectorId);
                const record =
                    records.find((candidate) => candidate.id === currentConnector?.connection) ?? records[0];
                if (!record)
                    return yield* connectError("NeedsAuthentication", "OAuth session is unavailable.");
                return record;
            });
            const complete = Effect.fn("Connect.browser.complete")(function* (url: string) {
                const state = new URL(url).searchParams.get("state");
                if (!state || !(yield* get("OAuthAuthorizationAttempt", state))) return;
                const completed = yield* apply("completeAuthorization", {
                    callbackUrl: url,
                    principalId: runtime.owner,
                });
                const connection = yield* get("OAuthConnection", completed.connectionId);
                if (!connection)
                    return yield* connectError("NotFound", "Completed connection is unavailable.");
                return session(connection);
            });
            yield* maintainConnect(connect).pipe(Effect.provideService(Scope.Scope, owner));
            const browser = runtime.browserAuthentication;
            return {
                beginAuthorization: () =>
                    run(
                        apply("beginAuthorization", {
                            connectorId,
                            principalId: runtime.owner,
                            redirectUrl: options.redirectUrl,
                        }).pipe(
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
                            const started = yield* apply("beginAuthorization", {
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
                            const records = yield* load("OAuthConnection", {
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
                                const available = yield* Effect.result(
                                    backend.encrypted!.decrypt({
                                        ...handle,
                                        source: {
                                            objectType: "OAuthConnection",
                                            primaryKey: record.id,
                                            property: record.refreshToken ? "refreshToken" : "accessToken",
                                        },
                                    })
                                );
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
                            yield* apply("refreshConnection", { connectionId: record.id });
                            const updated = yield* get("OAuthConnection", record.id);
                            if (!updated)
                                return yield* connectError("NotFound", "Connection is unavailable.");
                            return session(updated);
                        })
                    ),
                getAccessToken: (userId) =>
                    run(
                        Effect.gen(function* () {
                            return yield* connectionAccessToken(backend, (yield* find(userId)).id);
                        })
                    ),
                revoke: (userId) =>
                    run(
                        Effect.gen(function* () {
                            const records = yield* load("OAuthConnection", {
                                where: and(
                                    eq(field("connector"), connectorId),
                                    eq(field("providerSubjectId"), userId)
                                ),
                            });
                            for (const record of records)
                                yield* apply("disconnectConnection", { connectionId: record.id });
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
