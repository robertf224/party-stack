import { createServer } from "node:net";
import { BrowserAuthenticationCancelledError } from "@party-stack/runtime";
import { describe, expect, it, vi } from "vitest";
import { createNodeBrowserAuthentication } from "./createNodeBrowserAuthentication.js";

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
        const session = authentication.start({
            redirectUrl,
        });

        await expect(session.open("https://auth.example/authorize")).resolves.toEqual({
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
        const session = authentication.start({
            redirectUrl: `http://127.0.0.1:${port}/callback`,
        });
        const result = session.open("https://auth.example/authorize");
        await didOpen;

        await session.close();

        await expect(result).rejects.toBeInstanceOf(BrowserAuthenticationCancelledError);
    });

    it("rejects non-loopback redirects", () => {
        const authentication = createNodeBrowserAuthentication();

        expect(() =>
            authentication.start({
                redirectUrl: "https://app.example/callback",
            })
        ).toThrow("requires an http:// loopback redirect URL");
    });
});
