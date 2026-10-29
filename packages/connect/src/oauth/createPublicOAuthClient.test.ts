import { isUnauthenticatedError } from "@party-stack/ontology-backend";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { makeKeyMaterialStoreKeyring } from "@party-stack/runtime";
import {
    memoryRuntimeFixture,
    defineRuntimeFixture,
    runtimeFixtureContext,
} from "@party-stack/runtime/testing";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { createPublicOAuthClient } from "./createPublicOAuthClient.js";

describe("createPublicOAuthClient", () => {
    it.each([false, true])(
        "restores redirect PKCE state after client restart (owned tables: %s)",
        async (ownedTables) => {
            const values = new Map<string, string>();
            let authorizationUrl: string | undefined;
            const runtime = defineRuntimeFixture(() => ({
                ...memoryRuntimeFixture("installation", `oauth-${crypto.randomUUID()}`),
                tables: ownedTables ? Memory.make() : undefined,
                encryptionKeyring: makeKeyMaterialStoreKeyring({
                    get: (key: string) => Effect.sync(() => values.get(key)),
                    set: (key: string, value: string) =>
                        Effect.sync(() => {
                            values.set(key, value);
                        }),
                    delete: (key: string) =>
                        Effect.sync(() => {
                            values.delete(key);
                        }),
                }),
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
            }))("installation", "oauth");
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
            const options = {
                clientId: "client",
                redirectUrl: "https://app.example/callback",
                scopes: ["offline_access", "data"],
                authorizationServer: {
                    issuer: "https://auth.example",
                    authorizationEndpoint: "https://auth.example/authorize",
                    tokenEndpoint: "https://auth.example/token",
                    revocationEndpoint: "https://auth.example/revoke",
                },
                runtime: runtimeFixtureContext(runtime).service,
                scope: runtimeFixtureContext(runtime).scope,
                fetch,
                resolveUserId: () => "user-1",
            };
            let client = await createPublicOAuthClient(options);

            void client.signIn().catch(() => undefined);
            await vi.waitFor(() => {
                expect(authorizationUrl).toBeDefined();
            });
            const state = new URL(authorizationUrl!).searchParams.get("state");
            if (ownedTables) {
                await client.cleanup();
                client = await createPublicOAuthClient(options);
            }
            const session = await client.completeRedirect(
                `https://app.example/callback?code=code&state=${state}`
            );

            expect(session?.userId).toBe("user-1");
            await expect(client.getAccessToken("user-1")).resolves.toBe("access-initial");
            expect([...values.values()].some((value) => value.includes("refresh-initial"))).toBe(false);
            expect(values.size).toBe(2);

            await client.refresh("user-1");
            await expect(client.getAccessToken("user-1")).resolves.toBe("access-refreshed");

            await client.revoke("user-1");
            await expect(client.getAccessToken("user-1")).rejects.toThrow(/unavailable/);

            await client.cleanup();
            await runtime.cleanup?.();
        }
    );

    it("requires an encryption keyring instead of falling back to ordinary credential storage", async () => {
        const runtime = memoryRuntimeFixture("installation", `oauth-${crypto.randomUUID()}`);

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
                runtime: runtimeFixtureContext(runtime).service,
                scope: runtimeFixtureContext(runtime).scope,
                resolveUserId: () => "user-1",
            })
        ).rejects.toThrow(/requires an encryption keyring/);

        await runtime.cleanup?.();
    });

    it("restores expired refreshable sessions without network access", async () => {
        const values = new Map<string, string>();
        const runtime = {
            ...memoryRuntimeFixture("installation", `oauth-${crypto.randomUUID()}`),
            encryptionKeyring: makeKeyMaterialStoreKeyring({
                get: (key: string) => Effect.sync(() => values.get(key)),
                set: (key: string, value: string) =>
                    Effect.sync(() => {
                        values.set(key, value);
                    }),
                delete: (key: string) =>
                    Effect.sync(() => {
                        values.delete(key);
                    }),
            }),
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
        runtimeFixtureContext(runtime);
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
            runtime: runtimeFixtureContext(runtime).service,
            scope: runtimeFixtureContext(runtime).scope,
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

it("runtime shutdown aborts token refresh and closes the OAuth owner without discarding persisted credentials", async () => {
    const tables = await Effect.runPromise(Memory.make());
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
    ]);
    const namespace = `oauth-cancel-${crypto.randomUUID()}`;
    const provider = defineRuntimeFixture((owner, namespace) => ({
        ...memoryRuntimeFixture(owner, namespace),
        tables: Effect.succeed(tables),
        encryptionKeyring: Effect.succeed({
            active: Effect.succeed({ id: "key", key }),
            get: () => Effect.succeed(key),
        }),
        browserAuthentication: {
            start: ({ redirectUrl }: { redirectUrl: string }) => ({
                open: async (authorizationUrl: string) => ({
                    callbackUrl: `${redirectUrl}?code=fixture&state=${new URL(authorizationUrl).searchParams.get("state")}`,
                }),
                close: () => {},
            }),
        },
    }));
    const runtime = provider("installation", namespace);
    let refreshSignal: AbortSignal | null | undefined;
    let requests = 0;
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
        if (++requests === 1)
            return Promise.resolve(
                Response.json({
                    access_token: "fixture-access",
                    refresh_token: "fixture-refresh",
                    token_type: "Bearer",
                    expires_in: 3600,
                })
            );
        refreshSignal = init?.signal;
        return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("OAuth owner closed")), {
                once: true,
            });
        });
    });
    const options = {
        runtime: runtimeFixtureContext(runtime).service,
        scope: runtimeFixtureContext(runtime).scope,
        fetch,
        clientId: "client",
        redirectUrl: "https://app.example/callback",
        scopes: ["offline_access"],
        authorizationServer: {
            issuer: "https://auth.example",
            authorizationEndpoint: "https://auth.example/authorize",
            tokenEndpoint: "https://auth.example/token",
        },
        resolveUserId: () => "user",
    };
    const client = await createPublicOAuthClient(options);
    await client.signIn();
    expect(await client.getAccessToken("user")).toBe("fixture-access");
    const refreshed = client.refresh("user").catch((error: unknown) => error);
    await vi.waitFor(() => expect(refreshSignal).toBeDefined());
    await runtime.cleanup?.();
    expect(refreshSignal?.aborted).toBe(true);
    expect(await refreshed).toBeInstanceOf(Error);
    await client.cleanup();
    const reopenedRuntime = provider("installation", namespace);
    const reopened = await createPublicOAuthClient({
        ...options,
        runtime: runtimeFixtureContext(reopenedRuntime).service,
        scope: runtimeFixtureContext(reopenedRuntime).scope,
    });
    try {
        expect((await reopened.restoreSessions()).map((session) => session.userId)).toEqual(["user"]);
        expect(await reopened.getAccessToken("user")).toBe("fixture-access");
        expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
        await reopened.cleanup();
        await reopenedRuntime.cleanup?.();
    }
});
