import { createDefaultRuntime } from "@party-stack/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFoundryConnectionAdapter } from "./connection.js";

function base64Url(value: string): string {
    return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function foundryToken(): string {
    const subject = String.fromCharCode(...Array.from({ length: 16 }, (_, index) => index));
    return [
        base64Url(JSON.stringify({ alg: "none" })),
        base64Url(JSON.stringify({ sub: base64Url(subject) })),
        "",
    ].join(".");
}

describe("createFoundryConnectionAdapter", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("injects bearer authority only for its Foundry origin", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>(() =>
            Promise.resolve(new Response(null, { status: 204 }))
        );
        const createWebSocket = vi.fn(() => Promise.resolve({} as WebSocket));
        const token = foundryToken();
        const adapterProvider = createFoundryConnectionAdapter({
            baseUrl: "https://foundry.example.com",
            token,
        });
        const adapter = await adapterProvider({
            installationId: "foundry",
            runtime: {} as never,
        });
        const [established] = await adapter.restoreConnections();
        if (!established?.session.egress) {
            throw new Error("Expected Foundry egress wrapper.");
        }
        const egress = established.session.egress({
            fetch,
            createWebSocket,
        });

        await egress.fetch(new Request("https://foundry.example.com/api/data"));
        const request = fetch.mock.calls[0]![0] as Request;
        expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);

        await egress.createWebSocket("wss://foundry.example.com/socket");
        expect(createWebSocket).toHaveBeenCalledWith("wss://foundry.example.com/socket", [`Bearer-${token}`]);

        expect(fetch).toHaveBeenCalledOnce();
    });

    it("exposes API-token authentication through the connection controller", async () => {
        const token = foundryToken();
        const adapter = await createFoundryConnectionAdapter({
            baseUrl: "https://foundry.example.com",
        })({
            installationId: "foundry",
            runtime: {} as never,
        });
        const connect = vi.fn(() => Promise.resolve());
        const authentication = adapter.createAuthenticationClient({
            connect,
            disconnect: () => Promise.resolve(),
        });

        const connection = await authentication.signIn.apiToken({ token });

        expect(connection.state.status).toBe("active");
        expect(connect).toHaveBeenCalledWith(
            expect.objectContaining({
                connection,
            })
        );
    });

    it("composes server-only client credentials authentication", async () => {
        const token = foundryToken();
        const fetch = vi.fn<typeof globalThis.fetch>(() =>
            Promise.resolve(
                Response.json({
                    access_token: token,
                    token_type: "Bearer",
                    expires_in: 3600,
                })
            )
        );
        const adapter = await createFoundryConnectionAdapter({
            baseUrl: "https://foundry.example.com",
            clientCredentials: {
                clientId: "client",
                clientSecret: "secret",
                fetch,
            },
        })({
            installationId: "foundry",
            runtime: {} as never,
        });
        const connect = vi.fn(() => Promise.resolve());
        const authentication = adapter.createAuthenticationClient({
            connect,
            disconnect: () => Promise.resolve(),
        });

        const connection = await authentication.signIn.clientCredentials();

        expect(connection.state.status).toBe("active");
        expect(connect).toHaveBeenCalledWith(
            expect.objectContaining({
                connection,
            })
        );
        expect(fetch).toHaveBeenCalledOnce();
    });

    it("composes stored public OAuth authentication", async () => {
        const values = new Map<string, string>();
        const runtime = {
            ...createDefaultRuntime("installation", `foundry-oauth-${crypto.randomUUID()}`),
            secrets: {
                get: (key: string) => Promise.resolve(values.get(key)),
                set: (key: string, value: string) => {
                    values.set(key, value);
                    return Promise.resolve();
                },
                delete: (key: string) => {
                    values.delete(key);
                    return Promise.resolve();
                },
            },
            browserAuthentication: {
                start({ redirectUrl }: { redirectUrl: string }) {
                    return {
                        open(authorizationUrl: string) {
                            const state = new URL(authorizationUrl).searchParams.get("state");
                            return Promise.resolve({
                                callbackUrl: `${redirectUrl}?code=code&state=${state}`,
                            });
                        },
                        close() {},
                    };
                },
            },
        };
        const token = foundryToken();
        const adapter = await createFoundryConnectionAdapter({
            baseUrl: "https://foundry.example.com",
            oauth: {
                clientId: "client",
                redirectUrl: "https://app.example/callback",
                fetch: () =>
                    Promise.resolve(
                        Response.json({
                            access_token: token,
                            refresh_token: "refresh",
                            token_type: "Bearer",
                            expires_in: 3600,
                        })
                    ),
            },
        })({
            installationId: "foundry",
            runtime,
        });
        const connect = vi.fn(() => Promise.resolve());
        const authentication = adapter.createAuthenticationClient({
            connect,
            disconnect: () => Promise.resolve(),
        });

        const connection = await authentication.signIn.oauth();

        expect(connection.state.status).toBe("active");
        expect(connect).toHaveBeenCalledWith(
            expect.objectContaining({
                connection,
            })
        );
        expect([...values.values()].some((value) => value.includes("refresh"))).toBe(true);

        await adapter.cleanup?.();
        await runtime.cleanup?.();
    });
});
