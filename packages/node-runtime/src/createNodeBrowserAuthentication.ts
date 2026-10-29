import { serve } from "@hono/node-server";
import { BrowserAuthenticationError, type BrowserAuthentication } from "@party-stack/runtime";
import { Effect } from "effect";
import { Hono } from "hono";
import open from "open";
import type { Server } from "node:http";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
export interface CreateNodeBrowserAuthenticationOptions {
    openUrl?: (url: string) => Promise<unknown>;
    timeoutMs?: number;
}

export function createNodeBrowserAuthentication(
    options: CreateNodeBrowserAuthenticationOptions = {}
): BrowserAuthentication {
    const openUrl = options.openUrl ?? ((url: string) => open(url));
    return {
        start: Effect.fnUntraced(function* ({ redirectUrl }) {
            const redirect = yield* Effect.try({
                try: () => {
                    const url = new URL(redirectUrl);
                    if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || !url.port)
                        throw new Error(
                            "Node browser authentication requires an http:// loopback redirect URL with an explicit port."
                        );
                    return url;
                },
                catch: (cause) =>
                    new BrowserAuthenticationError({
                        reason: "Configuration",
                        message: cause instanceof Error ? cause.message : "Invalid redirect URL.",
                        cause,
                    }),
            });
            let server: Server | undefined;
            let closing: Promise<void> | undefined;
            let listenFailed = false;
            let cancel: (() => void) | undefined;
            let used = false;
            let closed = false;
            const closeServer = () =>
                (closing ??= new Promise<void>((resolve, reject) => {
                    if (!server || listenFailed) {
                        resolve();
                        return;
                    }
                    const active = server;
                    const stop = () => {
                        active.removeListener("error", failed);
                        active.close((error) => (error ? reject(error) : resolve()));
                        active.closeAllConnections();
                    };
                    const failed = () => {
                        active.removeListener("listening", stop);
                        resolve();
                    };
                    if (active.listening) stop();
                    else {
                        active.once("listening", stop);
                        active.once("error", failed);
                    }
                }));
            yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                    closed = true;
                    cancel?.();
                }).pipe(Effect.andThen(Effect.promise(closeServer)))
            );
            return {
                open: (authorizationUrl: string) =>
                    Effect.suspend(() => {
                        if (used || closed)
                            return Effect.fail(
                                new BrowserAuthenticationError({
                                    reason: "Configuration",
                                    message: "This authentication session has already been used or closed.",
                                })
                            );
                        used = true;
                        return Effect.callback<{ callbackUrl: string }, BrowserAuthenticationError>(
                            (resume) => {
                                let settled = false;
                                const finish = (
                                    result: Effect.Effect<{ callbackUrl: string }, BrowserAuthenticationError>
                                ) => {
                                    if (settled) return;
                                    settled = true;
                                    cancel = undefined;
                                    resume(result);
                                };
                                cancel = () =>
                                    finish(
                                        Effect.fail(
                                            new BrowserAuthenticationError({
                                                reason: "Cancelled",
                                                message: "Browser authentication was cancelled.",
                                            })
                                        )
                                    );
                                const app = new Hono();
                                app.get(redirect.pathname, (context) => {
                                    if (settled)
                                        return context.text(
                                            "Authentication session is already complete.",
                                            409
                                        );
                                    const callbackUrl = context.req.url;
                                    setImmediate(() => finish(Effect.succeed({ callbackUrl })));
                                    return context.html(
                                        '<!doctype html><html lang="en"><head><title>Authentication complete</title></head><body><p>Authentication complete. Returning to the terminal…</p><script>window.close()</script></body></html>'
                                    );
                                });
                                try {
                                    server = serve({
                                        fetch: app.fetch,
                                        hostname: redirect.hostname.replace(/^\[|\]$/g, ""),
                                        port: Number(redirect.port),
                                    }) as Server;
                                    server.once("error", (cause) => {
                                        listenFailed = true;
                                        finish(
                                            Effect.fail(
                                                new BrowserAuthenticationError({
                                                    reason: "Platform",
                                                    message:
                                                        "Could not start the authentication callback server.",
                                                    cause,
                                                })
                                            )
                                        );
                                    });
                                    server.once("listening", () => {
                                        if (settled) return;
                                        void Promise.resolve()
                                            .then(() => openUrl(authorizationUrl))
                                            .catch((cause: unknown) =>
                                                finish(
                                                    Effect.fail(
                                                        new BrowserAuthenticationError({
                                                            reason: "Platform",
                                                            message: "Could not open browser authorization.",
                                                            cause,
                                                        })
                                                    )
                                                )
                                            );
                                    });
                                } catch (cause) {
                                    finish(
                                        Effect.fail(
                                            new BrowserAuthenticationError({
                                                reason: "Platform",
                                                message: "Could not start browser authentication.",
                                                cause,
                                            })
                                        )
                                    );
                                }
                                return Effect.sync(() => {
                                    settled = true;
                                    cancel = undefined;
                                }).pipe(Effect.andThen(Effect.promise(closeServer)));
                            }
                        ).pipe(
                            Effect.timeoutOrElse({
                                duration: options.timeoutMs ?? 5 * 60 * 1000,
                                orElse: () =>
                                    Effect.fail(
                                        new BrowserAuthenticationError({
                                            reason: "Cancelled",
                                            message: "Browser authentication timed out.",
                                        })
                                    ),
                            })
                        );
                    }),
            };
        }),
    };
}
