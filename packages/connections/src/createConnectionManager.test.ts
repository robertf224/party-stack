import { unauthenticated } from "@party-stack/errors";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { createDefaultRuntime } from "@party-stack/runtime";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { createConnectionManager } from "./createConnectionManager.js";
import { createConnectionMonitor } from "./createConnectionMonitor.js";
import type { BackendConnectionAdapter, ConnectionEgressHandlers, EstablishedConnection } from "./types.js";

describe("createConnectionManager", () => {
    it("loads, connects, and disconnects stable user connections", async () => {
        const handlers: ConnectionEgressHandlers = {
            fetch: () => Promise.resolve(new Response()),
            createWebSocket: () => Promise.reject(new Error("unexpected websocket")),
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
        const runtime = createDefaultRuntime("installation", "connections-test");
        const manager = await createConnectionManager({
            installationId: "test-installation",
            runtime,
            adapter: () => adapter,
        });

        await manager.authentication.signIn("user-1");
        const connection = manager.connections.get("user-1")!;

        expect(connection).toMatchObject({
            userId: "user-1",
        });
        expect(connection.state.status).toBe("active");
        expect(manager.connections.get("user-1")).toEqual(connection);

        const monitor = createConnectionMonitor(manager, "user-1");
        const listener = vi.fn();
        const unsubscribe = monitor.subscribe(listener);
        await manager.authentication.signIn("user-2");
        await Promise.resolve();
        expect(listener).not.toHaveBeenCalled();

        await manager.disconnect("user-1");
        await Promise.resolve();
        expect(disconnect).toHaveBeenCalledOnce();
        expect(manager.connections.get("user-1")?.state.status).toBe("inactive");
        expect(listener).toHaveBeenLastCalledWith({
            status: "inactive",
        });
        unsubscribe();

        await monitor.reportUnauthenticated(unauthenticated("Session expired."));
        expect(monitor.state).toEqual({
            status: "needs-auth",
            error: "Session expired.",
        });
        await manager.forget("user-1");
        expect(manager.connections.get("user-1")).toBeUndefined();
        expect(monitor.state).toEqual({
            status: "inactive",
        });

        await manager.cleanup();
        await runtime.cleanup?.();
    });

    it("preserves persisted needs-auth connections when restoration omits them", async () => {
        const runtime = createDefaultRuntime("installation", `connections-needs-auth-${crypto.randomUUID()}`);
        const tables = await Effect.runPromise(Memory.make());
        const rows = [
            {
                key: "user-1",
                value: { userId: "user-1", state: { status: "needs-auth", error: "Session expired." } },
            },
        ];
        const table = Table.make<{ userId: string; state: { status: string; error: string } }>({
            name: JSON.stringify(["local", runtime.owner, runtime.namespace, "connections"]),
            version: 2,
        });
        await Effect.runPromise(tables.put(table, "user-1", rows[0]!.value));
        const manager = await createConnectionManager({
            installationId: "test-installation",
            runtime: { ...runtime, tables: Effect.succeed(tables) },
            adapter: () => ({
                name: "test",
                createAuthenticationClient: () => ({}),
                restoreConnections: () => Promise.resolve([]),
            }),
        });

        expect(manager.connections.get("user-1")?.state).toEqual({
            status: "needs-auth",
            error: "Session expired.",
        });
        expect(await Effect.runPromise(tables.get(table, "user-1"))).toMatchObject(rows[0]!.value);
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
                                    expiresAt: Date.now() - 1,
                                    refreshable: false,
                                },
                            },
                        },
                        session: {
                            disconnect: () => Promise.resolve(),
                        },
                    }),
            }),
            restoreConnections: () => Promise.resolve([]),
        };
        const runtime = createDefaultRuntime("installation", `connections-expiry-${crypto.randomUUID()}`);
        const manager = await createConnectionManager({
            installationId: "test-installation",
            runtime,
            adapter: () => adapter,
        });

        await manager.authentication.signIn();

        await vi.waitFor(() => {
            expect(manager.connections.get("user-1")?.state.status).toBe("needs-auth");
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
                            expiresAt: Date.now() + 60 * 60 * 1_000,
                            refreshable: true,
                        },
                    },
                },
                session: {
                    disconnect: () => Promise.resolve(),
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
                                status: "active",
                                expiration: {
                                    expiresAt: Date.now() - 1,
                                    refreshable: true,
                                },
                            },
                        },
                        session: {
                            refresh,
                            disconnect: () => Promise.resolve(),
                        },
                    },
                ]),
        };
        const runtime = createDefaultRuntime("installation", `connections-refresh-${crypto.randomUUID()}`);
        const manager = await createConnectionManager({
            installationId: "test-installation",
            runtime,
            adapter: () => adapter,
        });

        await vi.waitFor(() => {
            expect(refresh).toHaveBeenCalledOnce();
        });
        expect(manager.connections.get("user-1")?.state).toMatchObject({
            status: "active",
            expiration: {
                refreshable: true,
            },
        });
        await manager.cleanup();
        await runtime.cleanup?.();
    });
});

it("runtime shutdown interrupts refresh and disposes a late replacement session", async () => {
    const runtime = createDefaultRuntime("installation", `refresh-close-${crypto.randomUUID()}`);
    let resolveRefresh!: (value: EstablishedConnection) => void;
    let refreshSignal: AbortSignal | undefined;
    const releaseOld = vi.fn();
    const releaseLate = vi.fn();
    const releaseAdapter = vi.fn();
    const refresh = vi.fn((options?: { signal?: AbortSignal }) => {
        refreshSignal = options?.signal;
        return new Promise<EstablishedConnection>((resolve) => {
            resolveRefresh = resolve;
        });
    });
    const manager = await createConnectionManager({
        installationId: "refresh-close",
        runtime,
        adapter: () => ({
            name: "refresh-close",
            createAuthenticationClient: (controller) => ({
                connect: (value: EstablishedConnection) => controller.connect(value),
            }),
            restoreConnections: async () => [
                {
                    connection: {
                        userId: "user",
                        state: {
                            status: "active",
                            expiration: {
                                expiresAt: 0,
                                refreshable: true,
                            },
                        },
                    },
                    session: { refresh, disconnect: async () => {}, cleanup: releaseOld },
                },
            ],
            cleanup: releaseAdapter,
        }),
    });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await runtime.cleanup?.();
    expect(refreshSignal?.aborted).toBe(true);
    expect(manager.connections.status).toBe("cleaned-up");
    expect(releaseOld).toHaveBeenCalledOnce();
    expect(releaseAdapter).toHaveBeenCalledOnce();
    resolveRefresh({
        connection: { userId: "user", state: { status: "active" } },
        session: { disconnect: async () => {}, cleanup: releaseLate },
    });
    await vi.waitFor(() => expect(releaseLate).toHaveBeenCalledOnce());
    const releaseNew = vi.fn();
    await expect(
        manager.authentication.connect({
            connection: { userId: "new", state: { status: "active" } },
            session: { disconnect: async () => {}, cleanup: releaseNew },
        })
    ).rejects.toThrow("closed");
    expect(releaseNew).toHaveBeenCalledOnce();
    await manager.cleanup();
    expect(releaseAdapter).toHaveBeenCalledOnce();
});
