import { isUnauthenticatedError } from "@party-stack/errors";
import { createDefaultRuntime } from "@party-stack/runtime";
import { describe, expect, it, vi } from "vitest";
import { createPublicOAuthClient } from "./createPublicOAuthClient.js";

describe("createPublicOAuthClient", () => {
    it("stores PKCE and token state through RuntimeAdapter.secrets", async () => {
        const values = new Map<string, string>();
        let authorizationUrl: string | undefined;
        const runtime = {
            ...createDefaultRuntime("installation", `oauth-${crypto.randomUUID()}`),
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
                start() {
                    return {
                        open(candidateAuthorizationUrl: string) {
                            authorizationUrl = candidateAuthorizationUrl;
                            return new Promise<never>(() => undefined);
                        },
                        close() {},
                    };
                },
            },
        };
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            const request = new Request(input, init);
            const body = new URLSearchParams(await request.text());
            if (request.url.endsWith("/revoke")) {
                return new Response(null, {
                    status: 200,
                });
            }
            const refresh = body.get("grant_type") === "refresh_token";
            return Response.json({
                access_token: refresh ? "access-refreshed" : "access-initial",
                refresh_token: refresh ? "refresh-rotated" : "refresh-initial",
                token_type: "Bearer",
                expires_in: 3600,
                scope: "offline_access data",
            });
        });
        const client = await createPublicOAuthClient({
            clientId: "client",
            redirectUrl: "https://app.example/callback",
            scopes: ["offline_access", "data"],
            authorizationServer: {
                issuer: "https://auth.example",
                authorizationEndpoint: "https://auth.example/authorize",
                tokenEndpoint: "https://auth.example/token",
                revocationEndpoint: "https://auth.example/revoke",
            },
            runtime,
            fetch,
            resolveUserId: () => "user-1",
        });

        void client.signIn();
        await vi.waitFor(() => {
            expect(authorizationUrl).toBeDefined();
        });
        const state = new URL(authorizationUrl!).searchParams.get("state");
        const session = await client.completeRedirect(
            `https://app.example/callback?code=code&state=${state}`
        );

        expect(session?.userId).toBe("user-1");
        await expect(client.getAccessToken("user-1")).resolves.toBe("access-initial");
        expect([...values.values()].some((value) => value.includes("refresh-initial"))).toBe(true);

        await client.refresh("user-1");
        await expect(client.getAccessToken("user-1")).resolves.toBe("access-refreshed");

        await client.revoke("user-1");
        await expect(client.getAccessToken("user-1")).rejects.toThrow(/unavailable/);

        await client.cleanup();
        await runtime.cleanup?.();
    });

    it("requires explicit consent for ordinary persisted secret storage", async () => {
        const runtime = createDefaultRuntime("installation", `oauth-${crypto.randomUUID()}`);

        await expect(
            createPublicOAuthClient({
                clientId: "client",
                redirectUrl: "https://app.example/callback",
                scopes: [],
                authorizationServer: {
                    issuer: "https://auth.example",
                    authorizationEndpoint: "https://auth.example/authorize",
                    tokenEndpoint: "https://auth.example/token",
                },
                runtime,
                resolveUserId: () => "user-1",
            })
        ).rejects.toThrow(/RuntimeAdapter\.secrets/);

        await runtime.cleanup?.();
    });

    it("restores expired refreshable sessions without network access", async () => {
        const values = new Map<string, string>();
        const runtime = {
            ...createDefaultRuntime("installation", `oauth-${crypto.randomUUID()}`),
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
        let tokenRequests = 0;
        const fetch = vi.fn<typeof globalThis.fetch>(() => {
            tokenRequests += 1;
            return Promise.resolve(
                tokenRequests === 1
                    ? Response.json({
                          access_token: "expired-access",
                          refresh_token: "refresh",
                          token_type: "Bearer",
                          expires_in: 0,
                      })
                    : Response.json(
                          {
                              error: "invalid_grant",
                          },
                          { status: 400 }
                      )
            );
        });
        const client = await createPublicOAuthClient({
            clientId: "client",
            redirectUrl: "https://app.example/callback",
            scopes: ["offline_access"],
            authorizationServer: {
                issuer: "https://auth.example",
                authorizationEndpoint: "https://auth.example/authorize",
                tokenEndpoint: "https://auth.example/token",
            },
            runtime,
            fetch,
            resolveUserId: () => "user-1",
        });
        await client.signIn();
        expect(fetch).toHaveBeenCalledOnce();

        const restored = await client.restoreSessions();

        expect(restored).toHaveLength(1);
        expect(restored[0]?.userId).toBe("user-1");
        expect(typeof restored[0]?.expiration?.expiresAt).toBe("number");
        expect(restored[0]?.expiration?.refreshable).toBe(true);
        expect(fetch).toHaveBeenCalledOnce();
        const refreshError = await client.refresh("user-1").catch((error: unknown) => error);
        expect(isUnauthenticatedError(refreshError)).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(2);
        await expect(client.restoreSessions()).resolves.toEqual([]);
        await client.cleanup();
        await runtime.cleanup?.();
    });
});
