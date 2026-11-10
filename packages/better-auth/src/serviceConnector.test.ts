import { toWebEgress } from "@party-stack/connect";
import { Effect } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { makeBetterAuthServiceConnector } from "./serviceConnector.js";

test("external session attachment verifies identity and expiry before accepting its selector", async () => {
    const now = new Date();
    const sessions = [
        {
            session: {
                id: "verified",
                userId: "alice",
                token: "private-cookie",
                createdAt: now,
                updatedAt: now,
                expiresAt: new Date(Date.now() + 60_000),
            },
            user: {
                id: "alice",
                name: "Alice",
                email: "alice@example.com",
                emailVerified: true,
                createdAt: now,
                updatedAt: now,
            },
        },
    ];
    const revoke = vi.fn(() => Promise.resolve({ data: { status: true }, error: null }));
    const connector = makeBetterAuthServiceConnector({
        client: {
            multiSession: {
                listDeviceSessions: () => Promise.resolve({ data: sessions, error: null }),
                revoke,
            },
        },
    });
    const serviceInstance = {
        id: "app",
        title: "App",
        service: "better-auth",
        instanceUrl: "https://app.example",
    };
    expect(
        await Effect.runPromise(connector.externalSession!({ serviceInstance, sessionId: "verified" }))
    ).toMatchObject({ userId: "alice", title: "Alice" });
    expect(
        await Effect.runPromise(
            Effect.result(connector.externalSession!({ serviceInstance, sessionId: "invented" }))
        )
    ).toMatchObject({ _tag: "Failure", failure: { kind: "NeedsAuthentication" } });
    sessions[0]!.session.expiresAt = new Date(0);
    expect(
        await Effect.runPromise(
            Effect.result(connector.externalSession!({ serviceInstance, sessionId: "verified" }))
        )
    ).toMatchObject({ _tag: "Failure", failure: { kind: "NeedsAuthentication" } });
    await Effect.runPromise(connector.disconnectExternalSession!({ serviceInstance, sessionId: "verified" }));
    expect(revoke).toHaveBeenCalledWith({ sessionToken: "private-cookie" });
});

test("Better Auth egress follows the current selector and confines credentials to its service", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let selector = "first";
                const fetch = vi.fn((_request: Request) => Effect.succeed(new Response()));
                const socket = vi.fn(() => Effect.succeed({} as WebSocket));
                const connector = makeBetterAuthServiceConnector({
                    client: {
                        multiSession: {
                            listDeviceSessions: () => Promise.resolve({ data: [], error: null }),
                            revoke: () => Promise.resolve({ data: { status: true }, error: null }),
                        },
                    },
                });
                const nativeEgress = yield* connector.acquire({
                    serviceInstance: {
                        id: "app",
                        title: "App",
                        service: "better-auth",
                        instanceUrl: "https://app.example",
                    },
                    connection: {
                        objectType: "ExternalSessionConnection",
                        value: {
                            id: "connection",
                            serviceInstance: "app",
                            userId: "alice",
                            title: "Alice",
                            status: "active",
                            sessionId: "first",
                        },
                    },
                    credential: Effect.sync(() => selector),
                    refreshCredential: () => Effect.die("unused"),
                    handlers: { fetch, createWebSocket: socket },
                });
                const egress = yield* toWebEgress(nativeEgress);
                yield* Effect.promise(() => egress.fetch(new Request("https://app.example/data")));
                expect(fetch.mock.calls[0]![0].headers.get("x-party-stack-connection-session")).toBe("first");
                selector = "reauthenticated";
                yield* Effect.promise(() => egress.createWebSocket("wss://app.example/socket", "ontology"));
                expect(socket).toHaveBeenCalledWith("wss://app.example/socket", [
                    "party-stack.session.reauthenticated",
                    "ontology",
                ]);
                yield* Effect.promise(async () => {
                    await expect(
                        egress.fetch(new Request("https://other.example/data"))
                    ).rejects.toMatchObject({ kind: "Forbidden" });
                    await expect(egress.createWebSocket("wss://other.example/socket")).rejects.toMatchObject({
                        kind: "Forbidden",
                    });
                });
                expect(fetch).toHaveBeenCalledTimes(1);
                expect(socket).toHaveBeenCalledTimes(1);
            })
        )
    );
});

test.each([
    [401, "NeedsAuthentication", false],
    [403, "Forbidden", false],
    [400, "Provider", false],
    [408, "Provider", true],
    [429, "Provider", true],
    [500, "Provider", true],
    [503, "Provider", true],
    [undefined, "Provider", true],
] as const)(
    "session listing classifies HTTP %s without exposing provider details",
    async (status, kind, retryable) => {
        const connector = makeBetterAuthServiceConnector({
            client: {
                multiSession: {
                    listDeviceSessions: async () => ({
                        error: { status, message: "private-provider-details" },
                    }),
                    revoke: async () => ({}),
                },
            },
        });
        const result = await Effect.runPromise(
            Effect.result(
                connector.externalSession!({
                    serviceInstance: {
                        id: "app",
                        title: "App",
                        service: "better-auth",
                        instanceUrl: "https://app.example",
                    },
                    sessionId: "saved",
                })
            )
        );
        expect(result).toMatchObject({ _tag: "Failure", failure: { kind, retryable } });
        expect(JSON.stringify(result)).not.toContain("private-provider-details");
    }
);

test("a rejected session-list request remains a retryable availability error", async () => {
    const connector = makeBetterAuthServiceConnector({
        client: {
            multiSession: {
                listDeviceSessions: async () => {
                    throw new Error("private-provider-details");
                },
                revoke: async () => ({}),
            },
        },
    });
    expect(
        await Effect.runPromise(
            Effect.result(
                connector.externalSession!({
                    serviceInstance: {
                        id: "app",
                        title: "App",
                        service: "better-auth",
                        instanceUrl: "https://app.example",
                    },
                    sessionId: "saved",
                })
            )
        )
    ).toMatchObject({ _tag: "Failure", failure: { kind: "Provider", retryable: true } });
});
