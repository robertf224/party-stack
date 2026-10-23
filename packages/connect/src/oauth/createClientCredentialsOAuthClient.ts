import { Clock, Effect, Exit, Fiber, Scope, Semaphore } from "effect";
import { connectError } from "../core/errors.js";
import { makeOAuthProvider } from "../core/oauth.js";
import type { OAuthTokens } from "../core/Connect.js";
import type { OAuthSession } from "./types.js";

export interface CreateClientCredentialsOAuthClientOptions {
    scope?: Scope.Scope;
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
    cleanup(): Promise<void>;
}

/** SDK boundary for non-interactive credentials; its scope owns every request. */
export function createClientCredentialsOAuthClient(
    options: CreateClientCredentialsOAuthClientOptions
): ClientCredentialsOAuthClient {
    const owner = options.scope ? Effect.runSync(Scope.fork(options.scope)) : Scope.makeUnsafe();
    const gate = Semaphore.makeUnsafe(1);
    let current: OAuthTokens | undefined;
    let closed = false;
    Effect.runSync(
        Scope.addFinalizer(
            owner,
            Effect.sync(() => {
                closed = true;
                current = undefined;
            })
        )
    );
    const provider = makeOAuthProvider({
        issuer: new URL(options.tokenEndpoint).origin,
        authorizationEndpoint: options.tokenEndpoint,
        tokenEndpoint: options.tokenEndpoint,
        revocationEndpoint: options.revocationEndpoint,
        clientId: options.clientId,
        clientAuthentication: {
            method: options.tokenEndpointAuthMethod ?? "client_secret_post",
            secret: options.clientSecret,
        },
        scopes: options.scopes ?? [],
        fetch: options.fetch,
        resolveSubject: (token) =>
            Effect.tryPromise({
                try: () => Promise.resolve(options.resolveUserId(token)),
                catch: () => connectError("Provider", "Could not determine the provider identity."),
            }),
    });
    const session = (tokens: OAuthTokens): OAuthSession => ({
        userId: tokens.providerSubjectId,
        expiration: tokens.accessTokenExpiresAt
            ? { expiresAt: tokens.accessTokenExpiresAt.epochMilliseconds, refreshable: true }
            : undefined,
    });
    const run = <A>(effect: Effect.Effect<A, import("../core/errors.js").ConnectError>) =>
        Effect.runPromise(
            Effect.suspend(() => {
                if (closed)
                    return Effect.fail(connectError("Configuration", "OAuth client has been cleaned up."));
                return Effect.flatMap(Effect.forkIn(effect, owner), Fiber.join);
            })
        );
    const renew = (observed: OAuthTokens | undefined, force: boolean) =>
        gate.withPermits(1)(
            Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis;
                if (
                    current &&
                    (current !== observed ||
                        (!force &&
                            (current.accessTokenExpiresAt === undefined ||
                                current.accessTokenExpiresAt.epochMilliseconds > now + 5000)))
                )
                    return current;
                const tokens = yield* provider.clientCredentials;
                if (current && current.providerSubjectId !== tokens.providerSubjectId)
                    return yield* connectError("NeedsAuthentication", "Provider identity changed.");
                current = tokens;
                return tokens;
            })
        );
    return {
        getAccessToken: () => run(renew(current, false).pipe(Effect.map((tokens) => tokens.accessToken))),
        getSession: () => run(renew(current, false).pipe(Effect.map(session))),
        refresh: () => run(renew(current, true).pipe(Effect.map(session))),
        revoke: () =>
            run(
                gate.withPermits(1)(
                    Effect.gen(function* () {
                        const token = current?.accessToken;
                        current = undefined;
                        if (token && provider.revoke) yield* provider.revoke(token);
                    })
                )
            ),
        cleanup: () => {
            closed = true;
            current = undefined;
            return Effect.runPromise(Scope.close(owner, Exit.void));
        },
    };
}
