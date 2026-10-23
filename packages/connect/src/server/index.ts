import { Clock, Effect, Schema } from "effect";
import { connectError, type ConnectError } from "../core/errors.js";
import type { ConnectService } from "../core/Connect.js";
import type { ConnectStore } from "../core/store.js";

export interface ConnectPrincipal {
    id: string;
    sessionId: string;
}
export interface ConnectServerOptions {
    connect: ConnectService;
    store: ConnectStore;
    /** Fixed, provider-registered URL. Never accepted from a browser request. */
    callbackUrl: string;
    appOrigin: string;
    authenticate(request: Request): Effect.Effect<ConnectPrincipal, ConnectError>;
    /** Check project/org permissions again on completion; return trusted extra attempt properties on begin. */
    authorize(input: {
        operation: "begin" | "complete" | "inspect";
        principal: ConnectPrincipal;
        connectorId: string;
        connectionId?: string;
        context?: unknown;
        attempt?: import("../spec/index.js").OAuthAuthorizationAttemptRecord;
    }): Effect.Effect<Record<string, unknown> | void, ConnectError>;
}
const Start = Schema.Struct({
    connectorId: Schema.NonEmptyString,
    connectionId: Schema.optional(Schema.NonEmptyString),
    returnUrl: Schema.NonEmptyString,
    context: Schema.optional(Schema.Unknown),
});
const principalKey = (principal: ConnectPrincipal) => JSON.stringify([principal.id, principal.sessionId]);
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const response = (value: unknown, status = 200) => Response.json(value, { status, headers });

/** Mount /begin (POST), /callback (GET), /result (GET) beneath one application route.
 * Promise conversion belongs to the hosting framework; all work here stays Effectful.
 */
export function makeConnectServer(options: ConnectServerOptions) {
    return Effect.fn("Connect.http")(function* (request: Request) {
        const execute = Effect.gen(function* () {
            const url = new URL(request.url);
            const principal = yield* options.authenticate(request);
            if (request.method === "POST" && url.pathname.endsWith("/begin")) {
                if (request.headers.get("origin") !== new URL(options.appOrigin).origin)
                    return yield* connectError(
                        "Forbidden",
                        "Authorization must start from the application origin."
                    );
                const body = yield* Effect.tryPromise({
                    try: () => request.json(),
                    catch: () => connectError("Configuration", "Invalid authorization request."),
                });
                const input = yield* Schema.decodeUnknownEffect(Start)(body).pipe(
                    Effect.mapError(() => connectError("Configuration", "Invalid authorization request."))
                );
                const returnUrl = yield* Effect.try({
                    try: () => new URL(input.returnUrl, options.appOrigin),
                    catch: () => connectError("Configuration", "Invalid return URL."),
                });
                if (
                    returnUrl.origin !== new URL(options.appOrigin).origin ||
                    returnUrl.username ||
                    returnUrl.password
                )
                    return yield* connectError("Forbidden", "Return URL must belong to the application.");
                const properties = yield* options.authorize({
                    operation: "begin",
                    principal,
                    connectorId: input.connectorId,
                    connectionId: input.connectionId,
                    context: input.context,
                });
                const selected =
                    input.connectionId ??
                    (yield* options.connect.connectionForConnector(input.connectorId))?.id;
                const started = yield* options.connect.begin({
                    connectorId: input.connectorId,
                    connectionId: selected,
                    principalId: principalKey(principal),
                    redirectUrl: options.callbackUrl,
                    returnUrl: returnUrl.href,
                    properties: properties ?? undefined,
                });
                return response(started);
            }
            if (request.method === "GET" && url.pathname.endsWith("/status")) {
                const connectorId = url.searchParams.get("connectorId");
                if (!connectorId) return yield* connectError("Configuration", "Connector ID is required.");
                yield* options.authorize({ operation: "inspect", principal, connectorId });
                const connection = yield* options.connect.connectionForConnector(connectorId);
                return response({
                    connectorId,
                    connectionId: connection?.id,
                    status: connection?.status ?? "unconnected",
                });
            }
            if (
                request.method !== "GET" ||
                !(url.pathname.endsWith("/callback") || url.pathname.endsWith("/result"))
            )
                return response({ error: "NotFound" }, 404);
            const state = url.searchParams.get("state");
            const attempt = state ? yield* options.store.get("OAuthAuthorizationAttempt", state) : undefined;
            if (
                !attempt ||
                attempt.principalId !== principalKey(principal) ||
                attempt.expiresAt.epochMilliseconds <= (yield* Clock.currentTimeMillis)
            )
                return yield* connectError("InvalidAttempt", "Authorization attempt is unavailable.");
            yield* options.authorize({
                operation: "complete",
                principal,
                connectorId: attempt.connector,
                connectionId: attempt.connectionId,
                attempt,
            });
            if (url.pathname.endsWith("/result")) {
                if (attempt.status !== "completed") return response({ status: attempt.status });
                const connection = yield* options.store.get("OAuthConnection", attempt.connectionId);
                return response({ status: "completed", connectionId: connection?.id });
            }
            const completed = yield* options.connect.complete({
                callbackUrl: url.href,
                principalId: principalKey(principal),
            });
            if (!attempt.returnUrl) return response({ status: "completed", connectionId: completed.id });
            const target = new URL(attempt.returnUrl);
            target.searchParams.set("connectAttempt", attempt.id);
            target.searchParams.set("state", attempt.id);
            // The app completion page can relay this opaque reference for popup presentation.
            return new Response(null, { status: 303, headers: { ...headers, Location: target.href } });
        });
        return yield* execute.pipe(
            Effect.catch((error) =>
                Effect.succeed(
                    response(
                        { error: error.kind, message: error.message },
                        error.kind === "Forbidden"
                            ? 403
                            : error.kind === "NotFound"
                              ? 404
                              : error.kind === "Busy"
                                ? 409
                                : error.kind === "Provider" || error.kind === "Storage"
                                  ? 503
                                  : 400
                    )
                )
            )
        );
    });
}
