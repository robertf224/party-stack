import { serve } from "@hono/node-server";
import { BrowserAuthenticationCancelledError, type BrowserAuthentication } from "@party-stack/runtime";
import { Hono } from "hono";
import open from "open";
import type { Server } from "node:http";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface CreateNodeBrowserAuthenticationOptions {
    openUrl?: (url: string) => Promise<unknown>;
    timeoutMs?: number;
}

function closeServer(server: Server | undefined): Promise<void> {
    if (!server?.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

function validateRedirectUrl(redirectUrl: string): URL {
    const url = new URL(redirectUrl);
    if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || !url.port) {
        throw new Error(
            "Node browser authentication requires an http:// loopback redirect URL with an explicit port."
        );
    }
    return url;
}

export function createNodeBrowserAuthentication(
    options: CreateNodeBrowserAuthenticationOptions = {}
): BrowserAuthentication {
    const openUrl = options.openUrl ?? ((url: string) => open(url));
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return {
        start({ redirectUrl }) {
            const redirect = validateRedirectUrl(redirectUrl);
            let server: Server | undefined;
            let rejectPending: ((error: Error) => void) | undefined;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let settled = false;

            const finish = async () => {
                if (timer) clearTimeout(timer);
                timer = undefined;
                rejectPending = undefined;
                await closeServer(server);
                server = undefined;
            };

            return {
                open(authorizationUrl) {
                    if (server || settled) {
                        return Promise.reject(
                            new Error("This browser authentication session has already been used.")
                        );
                    }

                    return new Promise<{ callbackUrl: string }>((resolve, reject) => {
                        rejectPending = reject;
                        const app = new Hono();
                        app.get(redirect.pathname, (context) => {
                            if (settled) {
                                return context.text("Authentication session is already complete.", 409);
                            }
                            settled = true;
                            const callbackUrl = context.req.url;
                            setImmediate(() => {
                                void finish().then(
                                    () =>
                                        resolve({
                                            callbackUrl,
                                        }),
                                    reject
                                );
                            });
                            return context.html(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Authentication complete</title></head>
<body>
<p>Authentication complete. Returning to the terminal…</p>
<script>window.close()</script>
</body>
</html>`);
                        });

                        server = serve({
                            fetch: app.fetch,
                            hostname: redirect.hostname.replace(/^\[|\]$/g, ""),
                            port: Number(redirect.port),
                        }) as Server;
                        server.once("error", (error) => {
                            if (settled) return;
                            settled = true;
                            void finish().finally(() => reject(error));
                        });
                        server.once("listening", () => {
                            if (settled) return;
                            void Promise.resolve()
                                .then(() => openUrl(authorizationUrl))
                                .catch((error: unknown) => {
                                    if (settled) return;
                                    settled = true;
                                    const reason = error instanceof Error ? error : new Error(String(error));
                                    void finish().finally(() => reject(reason));
                                });
                        });
                        timer = setTimeout(() => {
                            if (settled) return;
                            settled = true;
                            void finish().finally(() =>
                                reject(
                                    new BrowserAuthenticationCancelledError(
                                        "Browser authentication timed out."
                                    )
                                )
                            );
                        }, timeoutMs);
                    });
                },
                async close() {
                    if (settled) {
                        await finish();
                        return;
                    }
                    settled = true;
                    const reject = rejectPending;
                    await finish();
                    reject?.(new BrowserAuthenticationCancelledError());
                },
            };
        },
    };
}
