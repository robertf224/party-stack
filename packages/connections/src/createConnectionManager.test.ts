import { unauthenticated } from "@party-stack/errors";
import { createDefaultRuntime } from "@party-stack/runtime";
import { describe, expect, it, vi } from "vitest";
import { createConnectionManager } from "./createConnectionManager.js";
import { createConnectionMonitor } from "./createConnectionMonitor.js";
import type {
    BackendConnectionAdapter,
    ConnectionEgressHandlers,
} from "./types.js";

describe("createConnectionManager", () => {
    it("loads, connects, and disconnects stable user connections", async () => {
        const handlers: ConnectionEgressHandlers = {
            fetch: () => Promise.resolve(new Response()),
            createWebSocket: () =>
                Promise.reject(new Error("unexpected websocket")),
        };
        const disconnect = vi.fn(() => Promise.resolve());
        const adapter: BackendConnectionAdapter<{
            signIn(userId: string): Promise<void>;
        }> = {
            name: "test",
            createAuthenticationClient: (controller) => ({
                signIn: (userId) =>
                    controller.connect({
                        connection: {
                            userId,
                            state: {
                                status: "active",
                            },
                        },
                        session: {
                            disconnect,
                            egress: () => handlers,
                        },
                    }),
            }),
            restoreConnections: () => Promise.resolve([]),
        };
        const runtime = createDefaultRuntime(
            "installation",
            "connections-test"
        );
        const manager = await createConnectionManager({
            installationId: "test-installation",
            runtime,
            adapter: () => adapter,
        });

        await manager.authentication.signIn("user-1");
        const connection =
            manager.connections.get("user-1")!;

        expect(connection).toMatchObject({
            userId: "user-1",
        });
        expect(connection.state.status).toBe("active");
        expect(manager.connections.get("user-1")).toEqual(connection);

        const monitor = createConnectionMonitor(
            manager,
            "user-1"
        );
        const listener = vi.fn();
        const unsubscribe = monitor.subscribe(listener);
        await manager.authentication.signIn("user-2");
        await Promise.resolve();
        expect(listener).not.toHaveBeenCalled();

        await manager.disconnect("user-1");
        await Promise.resolve();
        expect(disconnect).toHaveBeenCalledOnce();
        expect(
            manager.connections.get("user-1")?.state.status
        ).toBe("inactive");
        expect(listener).toHaveBeenLastCalledWith({
            status: "inactive",
        });
        unsubscribe();

        await monitor.reportUnauthenticated(
            unauthenticated("Session expired.")
        );
        expect(monitor.state).toEqual({
            status: "needs-auth",
            error: "Session expired.",
        });
        await manager.forget("user-1");
        expect(
            manager.connections.get(
                "user-1"
            )
        ).toBeUndefined();
        expect(monitor.state).toEqual({
            status: "inactive",
        });

        await manager.cleanup();
        await runtime.cleanup?.();
    });

    it("preserves persisted needs-auth connections when restoration omits them", async () => {
        const runtime = createDefaultRuntime(
            "installation",
            `connections-needs-auth-${crypto.randomUUID()}`
        );
        const applyCommittedTx = vi.fn(() =>
            Promise.resolve()
        );
        const manager =
            await createConnectionManager({
                installationId:
                    "test-installation",
                runtime: {
                    ...runtime,
                    persistence: {
                        loadSubset: () =>
                            Promise.resolve([
                                {
                                    key: "user-1",
                                    value: {
                                        userId:
                                            "user-1",
                                        state: {
                                            status:
                                                "needs-auth",
                                            error: "Session expired.",
                                        },
                                    },
                                },
                            ]),
                        applyCommittedTx,
                        ensureIndex: () =>
                            Promise.resolve(),
                    } as never,
                },
                adapter: () => ({
                    name: "test",
                    createAuthenticationClient:
                        () => ({}),
                    restoreConnections: () =>
                        Promise.resolve([]),
                }),
            });

        expect(
            manager.connections.get("user-1")
                ?.state
        ).toEqual({
            status: "needs-auth",
            error: "Session expired.",
        });
        expect(
            applyCommittedTx
        ).not.toHaveBeenCalled();
        await manager.cleanup();
        await runtime.cleanup?.();
    });

    it("marks expired non-refreshable connections as needing authentication", async () => {
        const adapter: BackendConnectionAdapter<{
            signIn(): Promise<void>;
        }> = {
            name: "expiring",
            createAuthenticationClient: (controller) => ({
                signIn: () =>
                    controller.connect({
                        connection: {
                            userId: "user-1",
                            state: {
                                status: "active",
                                expiration: {
                                    expiresAt:
                                        Date.now() -
                                        1,
                                    refreshable:
                                        false,
                                },
                            },
                        },
                        session: {
                            disconnect: () =>
                                Promise.resolve(),
                        },
                    }),
            }),
            restoreConnections: () => Promise.resolve([]),
        };
        const runtime = createDefaultRuntime(
            "installation",
            `connections-expiry-${crypto.randomUUID()}`
        );
        const manager = await createConnectionManager({
            installationId: "test-installation",
            runtime,
            adapter: () => adapter,
        });

        await manager.authentication.signIn();

        await vi.waitFor(() => {
            expect(
                manager.connections.get("user-1")
                    ?.state.status
            ).toBe("needs-auth");
        });
        await manager.cleanup();
        await runtime.cleanup?.();
    });

    it("immediately refreshes restored refreshable sessions", async () => {
        const refresh = vi.fn(() =>
            Promise.resolve({
                connection: {
                    userId: "user-1",
                    state: {
                        status: "active" as const,
                        expiration: {
                            expiresAt:
                                Date.now() +
                                60 * 60 * 1_000,
                            refreshable: true,
                        },
                    },
                },
                session: {
                    disconnect: () =>
                        Promise.resolve(),
                },
            })
        );
        const adapter: BackendConnectionAdapter = {
            name: "refreshable",
            createAuthenticationClient: () => ({}),
            restoreConnections: () =>
                Promise.resolve([
                    {
                        connection: {
                            userId: "user-1",
                            state: {
                                status:
                                    "active",
                                expiration: {
                                    expiresAt:
                                        Date.now() -
                                        1,
                                    refreshable:
                                        true,
                                },
                            },
                        },
                        session: {
                            refresh,
                            disconnect: () =>
                                Promise.resolve(),
                        },
                    },
                ]),
        };
        const runtime = createDefaultRuntime(
            "installation",
            `connections-refresh-${crypto.randomUUID()}`
        );
        const manager = await createConnectionManager({
            installationId: "test-installation",
            runtime,
            adapter: () => adapter,
        });

        await vi.waitFor(() => {
            expect(refresh).toHaveBeenCalledOnce();
        });
        expect(
            manager.connections.get("user-1")?.state
        ).toMatchObject({
            status: "active",
            expiration: {
                refreshable: true,
            },
        });
        await manager.cleanup();
        await runtime.cleanup?.();
    });
});
