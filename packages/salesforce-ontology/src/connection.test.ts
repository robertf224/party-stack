import { makeKeyMaterialStoreKeyring } from "@party-stack/runtime";
import { closeRuntimeFixture } from "@party-stack/runtime/testing";
import { runtimeFixtureContext, memoryRuntimeFixture } from "@party-stack/runtime/testing";
import { Effect, Exit, Scope } from "effect";
import type { BackendConnectionAdapterProvider } from "@party-stack/connect";
import type { RuntimeFixtureOptions } from "@party-stack/runtime/testing";
const releaseAdapters: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const close of releaseAdapters.splice(0)) await close();
});
async function openAdapter<A extends object>(
    provider: BackendConnectionAdapterProvider<A>,
    options: { installationId: string; runtime?: RuntimeFixtureOptions }
) {
    const runtime = options.runtime ?? memoryRuntimeFixture("installation", crypto.randomUUID());
    const managed = runtimeFixtureContext(runtime).runtime;
    const owner = await Effect.runPromise(Scope.fork(runtimeFixtureContext(runtime).scope));
    releaseAdapters.push(async () => {
        await Effect.runPromise(Scope.close(owner, Exit.void));
        await closeRuntimeFixture(runtime);
    });
    const adapter = await managed.runPromise(
        Scope.provide(provider({ installationId: options.installationId }), owner)
    );
    await Effect.runPromise(Scope.addFinalizer(owner, adapter.cleanup?.() ?? Effect.void));
    return adapter;
}

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createSalesforceConnectionAdapter } from "./connection.js";
import type { EstablishedConnection } from "@party-stack/connect";

describe("createSalesforceConnectionAdapter", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("injects bearer authority only for its Salesforce origin", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>(() =>
            Promise.resolve(new Response(null, { status: 204 }))
        );
        const adapter = await openAdapter(
            createSalesforceConnectionAdapter({
                instanceUrl: "https://example.my.salesforce.com",
                token: "access-token",
                userId: "005000000000001",
            }),
            {
                installationId: "salesforce",
            }
        );
        const [established] = await Effect.runPromise(adapter.restoreConnections());
        if (!established?.session.egress) {
            throw new Error("Expected Salesforce egress wrapper.");
        }
        const egress = established.session.egress({
            fetch,
            createWebSocket: () => Promise.resolve({} as WebSocket),
        });

        await egress.fetch(new Request("https://example.my.salesforce.com/services/data/v65.0/sobjects"));
        const request = fetch.mock.calls[0]![0] as Request;
        expect(request.headers.get("authorization")).toBe("Bearer access-token");
        await expect(egress.fetch(new Request("https://attacker.example/services/data"))).rejects.toThrow(
            'Salesforce egress not allowed for origin "https://attacker.example".'
        );
        expect(fetch).toHaveBeenCalledOnce();
    });

    it("exposes access-token authentication through the connection controller", async () => {
        const adapter = await openAdapter(
            createSalesforceConnectionAdapter({
                instanceUrl: "https://example.my.salesforce.com",
            }),
            {
                installationId: "salesforce",
            }
        );
        const connect = vi.fn(() => Effect.void);
        const authentication = adapter.createAuthenticationClient({
            connect,
            disconnect: () => Effect.void,
        });

        const connection = await authentication.signIn.accessToken({
            token: "access-token",
            userId: "005000000000001",
        });

        expect(connection).toEqual({
            userId: "005000000000001",
            state: { status: "active" },
        });
        expect(connect).toHaveBeenCalledWith(
            expect.objectContaining({
                connection,
            })
        );
    });

    it("establishes server-side client credentials connections", async () => {
        let tokenBody: URLSearchParams | undefined;
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            const request = new Request(input, init);
            if (request.url.endsWith("/services/oauth2/userinfo")) {
                return Response.json({
                    user_id: "005000000000001",
                });
            }
            tokenBody = new URLSearchParams(await request.text());
            return Response.json({
                access_token: "access-token",
                expires_in: 3600,
                token_type: "Bearer",
            });
        });
        const adapter = await openAdapter(
            createSalesforceConnectionAdapter({
                instanceUrl: "https://example.my.salesforce.com",
                clientCredentials: {
                    clientId: "client",
                    clientSecret: "secret",
                    fetch,
                },
            }),
            {
                installationId: "salesforce",
            }
        );

        const [established] = await Effect.runPromise(adapter.restoreConnections());

        expect(established?.connection).toMatchObject({
            userId: "005000000000001",
            state: {
                status: "active",
            },
        });
        expect(tokenBody?.get("grant_type")).toBe("client_credentials");
        expect(tokenBody?.get("client_secret")).toBe("secret");
        await Effect.runPromise(adapter.cleanup?.() ?? Effect.void);
    });

    it("composes stored public OAuth authentication", async () => {
        const values = new Map<string, string>();
        const runtime = {
            ...memoryRuntimeFixture("installation", `salesforce-oauth-${crypto.randomUUID()}`),
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
                start: ({ redirectUrl }: { redirectUrl: string }) =>
                    Effect.succeed({
                        open(authorizationUrl: string) {
                            const state = new URL(authorizationUrl).searchParams.get("state");
                            return Effect.succeed({
                                callbackUrl: `${redirectUrl}?code=code&state=${state}`,
                            });
                        },
                    }),
            },
        };
        const fetch = vi.fn<typeof globalThis.fetch>((input) => {
            const url =
                input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;
            return Promise.resolve(
                url.endsWith("/services/oauth2/userinfo")
                    ? Response.json({ user_id: "005000000000001" })
                    : Response.json({
                          access_token: "access-token",
                          refresh_token: "refresh-token",
                          token_type: "Bearer",
                          expires_in: 3600,
                      })
            );
        });
        const adapter = await openAdapter(
            createSalesforceConnectionAdapter({
                instanceUrl: "https://example.my.salesforce.com",
                oauth: {
                    clientId: "client",
                    redirectUrl: "http://localhost:1717/oauth/callback",
                    fetch,
                },
            }),
            {
                installationId: "salesforce",
                runtime,
            }
        );
        let established: EstablishedConnection | undefined;
        const connect = vi.fn((candidate: EstablishedConnection) => {
            established = candidate;
            return Effect.void;
        });
        const authentication = adapter.createAuthenticationClient({
            connect,
            disconnect: () => Effect.void,
        });

        const connection = await authentication.signIn.oauth();

        expect(connection.userId).toBe("005000000000001");
        expect(connection.state.status).toBe("active");
        expect(connect).toHaveBeenCalledWith(
            expect.objectContaining({
                connection,
            })
        );
        expect([...values.values()].some((value) => value.includes("refresh-token"))).toBe(false);
        expect(values.size).toBe(2);
        if (!established?.session.egress) {
            throw new Error("Expected OAuth egress wrapper.");
        }
        const backendFetch = vi
            .fn<typeof globalThis.fetch>()
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 401,
                })
            )
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 204,
                })
            );
        const egress = established.session.egress({
            fetch: backendFetch,
            createWebSocket: () => Promise.resolve({} as WebSocket),
        });

        await expect(
            egress.fetch(new Request("https://example.my.salesforce.com/services/data/v65.0/sobjects"))
        ).resolves.toMatchObject({
            status: 204,
        });
        expect(backendFetch).toHaveBeenCalledTimes(2);

        await Effect.runPromise(adapter.cleanup?.() ?? Effect.void);
        await closeRuntimeFixture(runtime);
    });
});
