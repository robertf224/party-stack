import { createServer } from "node:net";
import { BrowserAuthenticationError } from "@party-stack/runtime";
import { Effect, Exit, Fiber, Scope } from "effect";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createNodeBrowserAuthentication } from "./createNodeBrowserAuthentication.js";

let scope: Scope.Closeable;
beforeEach(() => {
    scope = Effect.runSync(Scope.make());
});
afterEach(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
});

async function availablePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error) reject(error);
            else resolve();
        });
    });
    return port;
}

describe("createNodeBrowserAuthentication", () => {
    it("opens the browser and resolves the loopback callback", async () => {
        const port = await availablePort();
        const redirectUrl = `http://127.0.0.1:${port}/oauth/callback`;
        let responseText: string | undefined;
        const openUrl = vi.fn(async (authorizationUrl: string) => {
            expect(authorizationUrl).toBe("https://auth.example/authorize");
            const response = await fetch(`${redirectUrl}?code=code&state=state`);
            responseText = await response.text();
        });
        const authentication = createNodeBrowserAuthentication({
            openUrl,
        });
        const session = Effect.runSync(
            Scope.provide(
                authentication.start({
                    redirectUrl,
                }),
                scope
            )
        );

        await expect(Effect.runPromise(session.open("https://auth.example/authorize"))).resolves.toEqual({
            callbackUrl: `${redirectUrl}?code=code&state=state`,
        });
        await vi.waitFor(() => {
            expect(responseText).toContain("window.close()");
        });
        expect(openUrl).toHaveBeenCalledOnce();
    });

    it("rejects a pending session when closed", async () => {
        const port = await availablePort();
        let opened: (() => void) | undefined;
        const didOpen = new Promise<void>((resolve) => {
            opened = resolve;
        });
        const authentication = createNodeBrowserAuthentication({
            openUrl: () => {
                opened?.();
                return Promise.resolve();
            },
        });
        const session = Effect.runSync(
            Scope.provide(
                authentication.start({
                    redirectUrl: `http://127.0.0.1:${port}/callback`,
                }),
                scope
            )
        );
        const result = Effect.runPromise(session.open("https://auth.example/authorize"));
        await didOpen;

        await Effect.runPromise(Scope.close(scope, Exit.void));

        await expect(result).rejects.toBeInstanceOf(BrowserAuthenticationError);
    });

    it("rejects non-loopback redirects", () => {
        const authentication = createNodeBrowserAuthentication();

        expect(() =>
            Effect.runSync(
                Scope.provide(
                    authentication.start({
                        redirectUrl: "https://app.example/callback",
                    }),
                    scope
                )
            )
        ).toThrow("requires an http:// loopback redirect URL");
    });

    it("interrupting before the loopback listener starts leaves the port available", async () => {
        const port = await availablePort();
        const openUrl = vi.fn(async () => {});
        const session = Effect.runSync(
            Scope.provide(
                createNodeBrowserAuthentication({ openUrl }).start({
                    redirectUrl: `http://127.0.0.1:${port}/callback`,
                }),
                scope
            )
        );
        const pending = Effect.runFork(session.open("https://auth.example/authorize"));
        await Effect.runPromise(Fiber.interrupt(pending));
        expect(openUrl).not.toHaveBeenCalled();
        const probe = createServer();
        try {
            await new Promise<void>((resolve, reject) => {
                probe.once("error", reject);
                probe.listen(port, "127.0.0.1", resolve);
            });
        } finally {
            await new Promise<void>((resolve) => probe.close(() => resolve()));
        }
    });
});
