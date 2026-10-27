import { unauthenticated } from "@party-stack/ontology-backend";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { memoryRuntimeFixture, runtimeFixtureContext } from "@party-stack/runtime/testing";
import { Deferred, Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { ConnectionError } from "./ConnectionError.js";
import { createConnectionManager } from "./createConnectionManager.js";
import { createConnectionMonitor } from "./createConnectionMonitor.js";
import type {
    BackendConnectionAdapter,
    ConnectionController,
    ConnectionManager,
    ConnectionEgressHandlers,
    EstablishedConnection,
} from "./types.js";

describe("createConnectionManager", () => {
    it("loads, connects, and disconnects stable user connections", async () => {
        const handlers: ConnectionEgressHandlers = {
            fetch: () => Promise.resolve(new Response()),
            createWebSocket: () => Promise.reject(new Error("unexpected websocket")),
        };
        const disconnect = vi.fn(() => Effect.void);
        const adapter: BackendConnectionAdapter<{
            signIn(userId: string): Promise<void>;
        }> = {
            name: "test",
            createAuthenticationClient: (controller) => ({
                signIn: (userId) =>
                    Effect.runPromise(
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
                        })
                    ),
            }),
            restoreConnections: () => Effect.succeed([]),
        };
        const runtime = memoryRuntimeFixture("installation", "connections-test");
        const manager = await createConnectionManager({
            installationId: "test-installation",
            runtime,
            adapter: () => Effect.succeed(adapter),
        });

        await manager.authentication.signIn("user-1");
        const connection = manager.connections.get("user-1")!;

        expect(connection).toMatchObject({
            userId: "user-1",
        });
        expect(connection.state.status).toBe("active");
        expect(manager.connections.get("user-1")).toEqual(connection);

        const monitor = createConnectionMonitor(
            {
                connections: manager.connections,
                subscribeConnection: (id, listener) => manager.subscribeConnection(id, listener),
                reportUnauthenticated: (id, error) =>
                    Effect.tryPromise({
                        try: () => manager.reportUnauthenticated(id, error),
                        catch: (cause) => ConnectionError.from("reportUnauthenticated", cause),
                    }),
            },
            "user-1"
        );
        const listener = vi.fn();
        const unsubscribe = monitor.subscribe(listener);
        await manager.authentication.signIn("user-2");
        await Promise.resolve();
        expect(manager.connections.get("user-1")).toBe(connection);
        expect(listener).not.toHaveBeenCalled();

        await manager.disconnect("user-1");
        await Promise.resolve();
        expect(disconnect).toHaveBeenCalledOnce();
        expect(manager.connections.get("user-1")?.state.status).toBe("inactive");
        expect(listener).toHaveBeenLastCalledWith({
            status: "inactive",
        });
        unsubscribe();

        await Effect.runPromise(monitor.reportUnauthenticated(unauthenticated("Session expired.")));
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
        const runtime = memoryRuntimeFixture("installation", `connections-needs-auth-${crypto.randomUUID()}`);
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
        const overriddenRuntime = { ...runtime, tables: Effect.succeed(tables) };
        runtimeFixtureContext(overriddenRuntime);
        const manager = await createConnectionManager({
            installationId: "test-installation",
            runtime: overriddenRuntime,
            adapter: () =>
                Effect.succeed({
                    name: "test",
                    createAuthenticationClient: () => ({}),
                    restoreConnections: () => Effect.succeed([]),
                }),
        });

        expect(manager.connections.get("user-1")?.state).toEqual({
            status: "needs-auth",
            error: "Session expired.",
        });
        expect(await Effect.runPromise(tables.get(table, "user-1"))).toMatchObject(rows[0]!.value);
        await manager.cleanup();
        await overriddenRuntime.cleanup();
        await runtime.cleanup?.();
    });

    it("marks expired non-refreshable connections as needing authentication", async () => {
        const adapter: BackendConnectionAdapter<{
            signIn(): Promise<void>;
        }> = {
            name: "expiring",
            createAuthenticationClient: (controller) => ({
                signIn: () =>
                    Effect.runPromise(
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
                                disconnect: () => Effect.void,
                            },
                        })
                    ),
            }),
            restoreConnections: () => Effect.succeed([]),
        };
        const runtime = memoryRuntimeFixture("installation", `connections-expiry-${crypto.randomUUID()}`);
        const manager = await createConnectionManager({
            installationId: "test-installation",
            runtime,
            adapter: () => Effect.succeed(adapter),
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
            Effect.succeed({
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
                    disconnect: () => Effect.void,
                },
            })
        );
        const adapter: BackendConnectionAdapter = {
            name: "refreshable",
            createAuthenticationClient: () => ({}),
            restoreConnections: () =>
                Effect.succeed([
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
                            disconnect: () => Effect.void,
                        },
                    },
                ]),
        };
        const runtime = memoryRuntimeFixture("installation", `connections-refresh-${crypto.randomUUID()}`);
        const manager = await createConnectionManager({
            installationId: "test-installation",
            runtime,
            adapter: () => Effect.succeed(adapter),
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

it("scope closure interrupts refresh, disposes sessions once and rejects late SDK callbacks", async () => {
    const runtime = memoryRuntimeFixture("installation", `refresh-close-${crypto.randomUUID()}`);
    const release = vi.fn();
    const releaseAdapter = vi.fn();
    const interrupted = vi.fn();
    const refresh = vi.fn(() => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(interrupted))));
    const manager = await createConnectionManager({
        installationId: "refresh-close",
        runtime,
        adapter: () =>
            Effect.succeed({
                name: "test",
                createAuthenticationClient: (controller) => ({
                    connect: (value: EstablishedConnection) => Effect.runPromise(controller.connect(value)),
                }),
                restoreConnections: () =>
                    Effect.succeed([
                        {
                            connection: {
                                userId: "user",
                                state: { status: "active", expiration: { expiresAt: 0, refreshable: true } },
                            },
                            session: {
                                refresh,
                                disconnect: () => Effect.void,
                                cleanup: () => Effect.sync(release),
                            },
                        },
                    ]),
                cleanup: () => Effect.sync(releaseAdapter),
            }),
    });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await runtime.cleanup?.();
    expect(interrupted).toHaveBeenCalledOnce();
    expect(manager.connections.size).toBe(0);
    expect(release).toHaveBeenCalledOnce();
    expect(releaseAdapter).toHaveBeenCalledOnce();
    const releaseNew = vi.fn();
    await expect(
        manager.authentication.connect({
            connection: { userId: "new", state: { status: "active" } },
            session: { disconnect: () => Effect.void, cleanup: () => Effect.sync(releaseNew) },
        })
    ).rejects.toThrow("closed");
    expect(releaseNew).toHaveBeenCalledOnce();
    await manager.cleanup();
    expect(releaseAdapter).toHaveBeenCalledOnce();
});

it("a late refresh cannot replace a newer login or resurrect a disconnected connection", async () => {
    const runtime = memoryRuntimeFixture("installation", `refresh-generation-${crypto.randomUUID()}`);
    const result = Effect.runSync(Deferred.make<EstablishedConnection>());
    const refresh = vi.fn(() => Deferred.await(result));
    const releaseLate = vi.fn();
    const releaseOld = vi.fn();
    const releaseNew = vi.fn();
    const manager = await createConnectionManager({
        installationId: "refresh-generation",
        runtime,
        adapter: () =>
            Effect.succeed({
                name: "test",
                createAuthenticationClient: (controller) => ({
                    connect: (value: EstablishedConnection) => Effect.runPromise(controller.connect(value)),
                }),
                restoreConnections: () =>
                    Effect.succeed([
                        {
                            connection: {
                                userId: "user",
                                state: { status: "active", expiration: { expiresAt: 0, refreshable: true } },
                            },
                            session: {
                                refresh,
                                disconnect: () => Effect.void,
                                cleanup: () => Effect.sync(releaseOld),
                            },
                        },
                    ]),
            }),
    });
    try {
        await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
        await manager.disconnect("user");
        expect(manager.connections.get("user")?.state.status).toBe("inactive");
        await manager.authentication.connect({
            connection: { userId: "user", state: { status: "active" } },
            session: { disconnect: () => Effect.void, cleanup: () => Effect.sync(releaseNew) },
        });
        await Effect.runPromise(
            Deferred.succeed(result, {
                connection: {
                    userId: "user",
                    state: { status: "active", expiration: { expiresAt: 1, refreshable: false } },
                },
                session: { disconnect: () => Effect.void, cleanup: () => Effect.sync(releaseLate) },
            })
        );
        await vi.waitFor(() => expect(releaseLate).toHaveBeenCalledOnce());
        expect(manager.connections.get("user")?.state).toEqual({ status: "active" });
        expect(releaseOld).toHaveBeenCalledOnce();
        expect(releaseNew).not.toHaveBeenCalled();
    } finally {
        await manager.cleanup();
        await runtime.cleanup?.();
    }
    expect(releaseNew).toHaveBeenCalledOnce();
});

it("failed restoration releases resources acquired by the adapter", async () => {
    const runtime = memoryRuntimeFixture("installation", `restore-failed-${crypto.randomUUID()}`);
    const release = vi.fn();
    const creating = createConnectionManager({
        installationId: "restore-failed",
        runtime,
        adapter: () =>
            Effect.gen(function* () {
                yield* Effect.acquireRelease(Effect.void, () => Effect.sync(release));
                return {
                    name: "failed",
                    createAuthenticationClient: () => ({}),
                    restoreConnections: () =>
                        Effect.fail(
                            new ConnectionError({
                                operation: "restore",
                                kind: "Unavailable",
                                message: "Restore failed.",
                            })
                        ),
                };
            }),
    });
    await expect(creating).rejects.toThrow("Restore failed");
    expect(release).toHaveBeenCalledOnce();
    await runtime.cleanup?.();
    expect(release).toHaveBeenCalledOnce();
});

it("closing the runtime interrupts restoration before the manager has been returned", async () => {
    const runtime = memoryRuntimeFixture("installation", `restore-interrupted-${crypto.randomUUID()}`);
    const release = vi.fn();
    const entered = vi.fn();
    const creating = createConnectionManager({
        installationId: "restore-interrupted",
        runtime,
        adapter: () =>
            Effect.gen(function* () {
                yield* Effect.acquireRelease(Effect.void, () => Effect.sync(release));
                return {
                    name: "interrupted",
                    createAuthenticationClient: () => ({}),
                    restoreConnections: () => Effect.andThen(Effect.sync(entered), Effect.never),
                };
            }),
    });
    const outcome = creating.then(
        () => "unexpected success",
        () => "interrupted"
    );
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    await runtime.cleanup?.();
    expect(await outcome).toBe("interrupted");
    expect(release).toHaveBeenCalledOnce();
});

it("a failed request from an old session cannot invalidate a newer login", async () => {
    const runtime = memoryRuntimeFixture("installation", `egress-generation-${crypto.randomUUID()}`);
    let rejectRequest!: (cause: unknown) => void;
    const request = new Promise<Response>((_resolve, reject) => {
        rejectRequest = reject;
    });
    const releaseNew = vi.fn();
    const manager = await createConnectionManager({
        installationId: "egress-generation",
        runtime,
        adapter: () =>
            Effect.succeed({
                name: "test",
                createAuthenticationClient: (controller) => ({
                    connect: (value: EstablishedConnection) => Effect.runPromise(controller.connect(value)),
                }),
                restoreConnections: () =>
                    Effect.succeed([
                        {
                            connection: { userId: "user", state: { status: "active" } },
                            session: {
                                disconnect: () => Effect.void,
                                egress: (handlers) => ({ ...handlers, fetch: () => request }),
                            },
                        },
                    ]),
            }),
    });
    try {
        const loading = manager.egress("user")!.fetch("https://provider.example/data");
        const failed = loading.then(
            () => undefined,
            (cause: unknown) => cause
        );
        await manager.authentication.connect({
            connection: { userId: "user", state: { status: "active" } },
            session: { disconnect: () => Effect.void, cleanup: () => Effect.sync(releaseNew) },
        });
        rejectRequest(unauthenticated("Expired old session"));
        expect(await failed).toMatchObject({ message: "Expired old session" });
        expect(manager.connections.get("user")?.state.status).toBe("active");
        expect(releaseNew).not.toHaveBeenCalled();
    } finally {
        await manager.cleanup();
        await runtime.cleanup?.();
    }
    expect(releaseNew).toHaveBeenCalledOnce();
});

it("interrupting a queued connection disposes its unadopted session", async () => {
    const runtime = memoryRuntimeFixture("installation", `queued-connect-${crypto.randomUUID()}`);
    const disconnecting = vi.fn();
    const releaseNew = vi.fn();
    const manager = await createConnectionManager({
        installationId: "queued-connect",
        runtime,
        adapter: () =>
            Effect.succeed({
                name: "test",
                createAuthenticationClient: (controller) => ({
                    connect: (value: EstablishedConnection) => Effect.runPromise(controller.connect(value)),
                }),
                restoreConnections: () =>
                    Effect.succeed([
                        {
                            connection: { userId: "user", state: { status: "active" } },
                            session: {
                                disconnect: () => Effect.andThen(Effect.sync(disconnecting), Effect.never),
                            },
                        },
                    ]),
            }),
    });
    const disconnect = manager.disconnect("user").catch(() => undefined);
    await vi.waitFor(() => expect(disconnecting).toHaveBeenCalledOnce());
    const connecting = manager.authentication
        .connect({
            connection: { userId: "user", state: { status: "active" } },
            session: { disconnect: () => Effect.void, cleanup: () => Effect.sync(releaseNew) },
        })
        .catch(() => undefined);
    // Allow the SDK callback to enter the effect and queue behind disconnect.
    await Promise.resolve();
    await manager.cleanup();
    await Promise.all([connecting, disconnect]);
    expect(releaseNew).toHaveBeenCalledOnce();
    await runtime.cleanup?.();
});

it("attempts every session and adapter finalizer even when one session cleanup fails", async () => {
    const runtime = memoryRuntimeFixture("installation", `cleanup-failure-${crypto.randomUUID()}`);
    const releaseOther = vi.fn();
    const releaseAdapter = vi.fn();
    const manager = await createConnectionManager({
        installationId: "cleanup-failure",
        runtime,
        adapter: () =>
            Effect.succeed({
                name: "test",
                createAuthenticationClient: () => ({}),
                restoreConnections: () =>
                    Effect.succeed([
                        {
                            connection: { userId: "one", state: { status: "active" } },
                            session: {
                                disconnect: () => Effect.void,
                                cleanup: () => Effect.die(new Error("Cleanup failed")),
                            },
                        },
                        {
                            connection: { userId: "two", state: { status: "active" } },
                            session: {
                                disconnect: () => Effect.void,
                                cleanup: () => Effect.sync(releaseOther),
                            },
                        },
                    ]),
                cleanup: () => Effect.sync(releaseAdapter),
            }),
    });
    await expect(manager.cleanup()).rejects.toThrow("Cleanup failed");
    expect(releaseOther).toHaveBeenCalledOnce();
    expect(releaseAdapter).toHaveBeenCalledOnce();
    expect(manager.connections.size).toBe(0);
    await runtime.cleanup?.();
});

it("logout can await an SDK session-change callback without deadlocking", async () => {
    const runtime = memoryRuntimeFixture("installation", `logout-callback-${crypto.randomUUID()}`);
    let controller!: ConnectionController;
    const release = vi.fn();
    const revoke = vi.fn(() => controller.disconnect("user"));
    const manager = await createConnectionManager({
        installationId: "logout-callback",
        runtime,
        adapter: () =>
            Effect.succeed({
                name: "test",
                createAuthenticationClient: (value) => {
                    controller = value;
                    return {};
                },
                restoreConnections: () =>
                    Effect.succeed([
                        {
                            connection: { userId: "user", state: { status: "active" } },
                            session: { disconnect: revoke, cleanup: () => Effect.sync(release) },
                        },
                    ]),
            }),
    });
    try {
        await manager.disconnect("user");
        expect(revoke).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
        expect(manager.connections.get("user")?.state.status).toBe("inactive");
        await manager.forget("user");
        expect(manager.connections.get("user")).toBeUndefined();
    } finally {
        await manager.cleanup();
        await runtime.cleanup?.();
    }
    expect(release).toHaveBeenCalledOnce();
});

it("restores and releases context-local sessions after another context signs in and logs out", async () => {
    const { defineRuntimeFixture } = await import("@party-stack/runtime/testing");
    const tables = await Effect.runPromise(Memory.make());
    const listeners = [new Set<() => void>(), new Set<() => void>()];
    const runtimes = listeners.map((own, index) =>
        defineRuntimeFixture((owner, namespace) => ({
            ...memoryRuntimeFixture(owner, namespace),
            tables: Effect.succeed(tables),
            storageNotifications: {
                publish: () => {
                    for (const listener of listeners[1 - index]!) listener();
                },
                subscribe: (listener: () => void) => {
                    own.add(listener);
                    return () => {
                        own.delete(listener);
                    };
                },
            },
        }))("installation", "shared-sessions")
    );
    let connected = false;
    let delayRestore = false;
    const restoring = Effect.runSync(Deferred.make<void>());
    const resume = Effect.runSync(Deferred.make<void>());
    const released = [vi.fn(), vi.fn()];
    const entry = (index: number): EstablishedConnection => ({
        connection: { userId: "user", state: { status: "active" } },
        session: {
            disconnect: () =>
                Effect.sync(() => {
                    connected = false;
                }),
            cleanup: () => Effect.sync(released[index]!),
        },
    });
    const managers: ConnectionManager<{ signIn(): Promise<void> }>[] = [];
    try {
        for (const [index, runtime] of runtimes.entries())
            managers.push(
                await createConnectionManager({
                    installationId: "shared",
                    runtime,
                    adapter: () =>
                        Effect.succeed({
                            name: "shared",
                            createAuthenticationClient: (controller: ConnectionController) => ({
                                signIn: () =>
                                    Effect.runPromise(
                                        Effect.andThen(
                                            Effect.sync(() => {
                                                connected = true;
                                            }),
                                            controller.connect(entry(index))
                                        )
                                    ),
                            }),
                            restoreConnections: () =>
                                Effect.gen(function* () {
                                    if (!connected) return [];
                                    const restored = entry(index);
                                    if (index === 1 && delayRestore) {
                                        delayRestore = false;
                                        yield* Deferred.succeed(restoring, undefined);
                                        yield* Deferred.await(resume);
                                    }
                                    return [restored];
                                }),
                        }),
                })
            );
        await managers[0]!.authentication.signIn();
        await vi.waitFor(() => expect(managers[1]!.egress("user")).toBeDefined());
        await managers[0]!.disconnect("user");
        await vi.waitFor(() => expect(managers[1]!.egress("user")).toBeUndefined());
        await vi.waitFor(() => expect(released[1]).toHaveBeenCalledOnce());
        delayRestore = true;
        await managers[0]!.authentication.signIn();
        await Effect.runPromise(Deferred.await(restoring));
        await managers[0]!.disconnect("user");
        await Effect.runPromise(Deferred.succeed(resume, undefined));
        await vi.waitFor(() => expect(released[1]).toHaveBeenCalledTimes(2));
        expect(managers[0]!.connections.get("user")?.state.status).toBe("inactive");
        expect(managers[1]!.egress("user")).toBeUndefined();
        await managers[0]!.authentication.signIn();
        await vi.waitFor(() => expect(managers[1]!.egress("user")).toBeDefined());
    } finally {
        for (const manager of managers) await manager.cleanup();
        for (const runtime of runtimes) await runtime.cleanup();
    }
    expect(listeners.map((value) => value.size)).toEqual([0, 0]);
});

it("an additional caller scope cannot extend a connection beyond the runtime's lifetime", async () => {
    const { Scope, Exit } = await import("effect");
    const caller = Effect.runSync(Scope.make());
    const runtime = memoryRuntimeFixture("installation", "bounded-parent");
    const release = vi.fn();
    let controller!: ConnectionController;
    const manager = await createConnectionManager({
        installationId: "bounded",
        runtime,
        scope: caller,
        adapter: () =>
            Effect.succeed({
                name: "bounded",
                createAuthenticationClient: (value: ConnectionController) => {
                    controller = value;
                    return {};
                },
                restoreConnections: () => Effect.succeed([]),
            }),
    });
    try {
        await Effect.runPromise(
            controller.connect({
                connection: { userId: "user", state: { status: "active" } },
                session: { disconnect: () => Effect.void, cleanup: () => Effect.sync(release) },
            })
        );
        await runtime.cleanup();
        expect(release).toHaveBeenCalledOnce();
        expect(manager.connections.size).toBe(0);
    } finally {
        await Effect.runPromise(Scope.close(caller, Exit.void));
        await manager.cleanup();
        await runtime.cleanup();
    }
});
