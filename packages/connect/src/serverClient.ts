import { Effect, Schema } from "effect";
import { connectError } from "./core/errors.js";
import type { BrowserAuthentication, BrowserAuthenticationPresentation } from "@party-stack/runtime";
const Started = Schema.Struct({ id: Schema.String, authorizationUrl: Schema.String });
const Result = Schema.Struct({ status: Schema.String, connectionId: Schema.optional(Schema.String) });

/** Browser-side transport for a server-owned connection. Tokens never cross this boundary. */
export function makeServerConnectClient(options: {
    baseUrl: string;
    returnUrl: string;
    browser: BrowserAuthentication;
    fetch?: typeof globalThis.fetch;
}) {
    const fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    const request = <A>(path: string, schema: Schema.Codec<A>, init?: RequestInit) =>
        Effect.gen(function* () {
            const response = yield* Effect.tryPromise({
                try: (signal) =>
                    fetch(
                        new URL(
                            path,
                            options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`
                        ),
                        { ...init, signal, credentials: "include" }
                    ),
                catch: () => connectError("Provider", "Connect server is unavailable.", true),
            });
            if (!response.ok)
                return yield* connectError(
                    response.status === 403 ? "Forbidden" : "Provider",
                    "Connect server rejected the request.",
                    response.status >= 500
                );
            const body = yield* Effect.tryPromise({
                try: () => response.json(),
                catch: () => connectError("Provider", "Connect server returned an invalid response."),
            });
            return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
                Effect.mapError(() =>
                    connectError("Provider", "Connect server returned an invalid response.")
                )
            );
        });
    const completeRedirect = Effect.fn("Connect.browser.result")(function* (url: string) {
        const id = new URL(url).searchParams.get("connectAttempt");
        if (!id) return;
        return yield* request(`result?state=${encodeURIComponent(id)}`, Result);
    });
    return {
        completeRedirect,
        /** Resource acquisition can be started in the click handler before other async work. */
        authorize: Effect.fn("Connect.browser.authorize")(function* (input: {
            connectorId: string;
            connectionId?: string;
            context?: unknown;
            browserPresentation?: BrowserAuthenticationPresentation;
        }) {
            return yield* Effect.scoped(
                Effect.gen(function* () {
                    const browser = yield* options.browser
                        .start({
                            redirectUrl: options.returnUrl,
                            presentation: input.browserPresentation,
                        })
                        .pipe(
                            Effect.mapError((error) =>
                                connectError(
                                    error.reason === "Configuration" ? "Configuration" : "InvalidAttempt",
                                    error.message
                                )
                            )
                        );
                    const started = yield* request("begin", Started, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            connectorId: input.connectorId,
                            connectionId: input.connectionId,
                            context: input.context,
                            returnUrl: options.returnUrl,
                        }),
                    });
                    const completed = yield* browser
                        .open(started.authorizationUrl)
                        .pipe(
                            Effect.mapError(() =>
                                connectError(
                                    "InvalidAttempt",
                                    "Browser authorization was cancelled or failed."
                                )
                            )
                        );
                    const actual = new URL(completed.callbackUrl);
                    const expected = new URL(options.returnUrl);
                    if (
                        actual.origin !== expected.origin ||
                        actual.pathname !== expected.pathname ||
                        actual.searchParams.get("connectAttempt") !== started.id
                    )
                        return yield* connectError(
                            "InvalidAttempt",
                            "Authorization completion did not match this attempt."
                        );
                    return yield* completeRedirect(completed.callbackUrl);
                })
            );
        }),
    };
}
