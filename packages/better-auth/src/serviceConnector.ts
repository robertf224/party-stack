import { ConnectError, withHttpAuthenticationErrors, type ServiceConnector } from "@party-stack/connect";
import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { Effect, Clock } from "effect";
import { Temporal } from "temporal-polyfill";
import { betterAuthError, listBetterAuthSessions } from "./sessions.js";
import { createPartyStackSessionProtocol, PARTY_STACK_SESSION_HEADER } from "./sessionSelection.js";
import type { BetterAuthSessionClient } from "./sessions.js";
export type { BetterAuthSessionClient } from "./sessions.js";

/** Better Auth owns cookies and session validation. Connect stores only a verified
 * selector and public identity; login continues to use the tab's Better Auth SDK.
 */
export function makeBetterAuthServiceConnector(options: {
    readonly client: BetterAuthSessionClient;
}): ServiceConnector {
    return {
        service: "better-auth",
        displayName: "Better Auth",
        externalSession: Effect.fnUntraced(function* ({ sessionId }) {
            const now = yield* Clock.currentTimeMillis;
            const current = (yield* listBetterAuthSessions(options.client)).find(
                (entry) => entry.session.id === sessionId && entry.session.expiresAt.getTime() > now
            );
            if (!current)
                return yield* new ConnectError({
                    kind: "NeedsAuthentication",
                    retryable: false,
                    message: "The selected Better Auth session is unavailable.",
                });
            return {
                userId: current.user.id,
                title: current.user.name ?? undefined,
                expiresAt: Temporal.Instant.fromEpochMilliseconds(current.session.expiresAt.getTime()),
            };
        }),
        disconnectExternalSession: Effect.fnUntraced(function* ({ sessionId }) {
            const current = (yield* listBetterAuthSessions(options.client)).find(
                (entry) => entry.session.id === sessionId
            );
            if (!current) return;
            const result = yield* Effect.tryPromise({
                try: () => options.client.multiSession.revoke({ sessionToken: current.session.token }),
                catch: (error) => betterAuthError(error, "Better Auth session revocation failed."),
            });
            if (result.error)
                return yield* betterAuthError(result.error, "Better Auth session revocation failed.");
        }),
        acquire: Effect.fnUntraced(function* ({ connection, serviceInstance, handlers, credential }) {
            if (connection.objectType !== "ExternalSessionConnection")
                return yield* new BackendError({
                    operation: "better-auth.acquire",
                    kind: "InvalidConfiguration",
                    retryable: false,
                    message: "Better Auth requires an external-session connection.",
                });
            const origin = new URL(serviceInstance.instanceUrl).origin;
            const check = (target: string | URL) =>
                Effect.try({
                    try: () => {
                        const url = new URL(target);
                        if (url.protocol === "wss:") url.protocol = "https:";
                        if (url.protocol === "ws:") url.protocol = "http:";
                        if (url.origin !== origin)
                            throw new BackendError({
                                operation: "better-auth.egress",
                                kind: "Forbidden",
                                retryable: false,
                                message: "Egress target does not match the service instance.",
                            });
                    },
                    catch: (cause) => classifyBackendFailure("better-auth.egress", cause),
                });
            return withHttpAuthenticationErrors({
                fetch: Effect.fnUntraced(function* (request: Request) {
                    yield* check(request.url);
                    const headers = new Headers(request.headers);
                    headers.set(PARTY_STACK_SESSION_HEADER, yield* credential);
                    return yield* handlers.fetch(new Request(request, { headers }));
                }),
                createWebSocket: Effect.fnUntraced(function* (
                    url: string | URL,
                    protocols?: string | string[]
                ) {
                    yield* check(url);
                    const requested = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
                    return yield* handlers.createWebSocket(url, [
                        createPartyStackSessionProtocol(yield* credential),
                        ...requested,
                    ]);
                }),
            });
        }),
    };
}
