import { isUnauthenticatedError, unauthenticated, type UnauthenticatedError } from "@party-stack/errors";
import { createLocalCollection, isCoordinationHost } from "@party-stack/runtime";
import { Runtime, runtimeEffects } from "@party-stack/runtime";
import { queryOnce } from "@tanstack/db";
import { Effect, Exit, Fiber, Queue, Scope } from "effect";
import { createDefaultConnectionEgressHandlers } from "./createDefaultConnectionEgressHandlers.js";
import {
    type BackendConnectionAdapter,
    type BackendConnectionAdapterProvider,
    type Connection,
    type ConnectionController,
    type ConnectionEgressHandlers,
    type ConnectionManager,
    type ConnectionSession,
    type EstablishedConnection,
} from "./types.js";
import type { RuntimeAdapter } from "@party-stack/runtime";

const REFRESH_POLL_MS = 30_000;
const REFRESH_WINDOW_MS = 60_000;

// TODO: Add lifecycle garbage collection. Automatically expire
// abandoned adapter-specific connection attempts, but retain established
// inactive/needs-auth connections unless the application explicitly
// forgets them or opts into a retention policy that protects open ontologies
// and pending outbox work.

export interface CreateConnectionManagerOptions<AuthenticationClient extends object = object> {
    installationId: string;
    runtime: RuntimeAdapter;
    scope?: Scope.Scope;
    adapter: BackendConnectionAdapterProvider<AuthenticationClient>;
    egressHandlers?: ConnectionEgressHandlers;
}

export async function createConnectionManager<AuthenticationClient extends object = object>(
    options: CreateConnectionManagerOptions<AuthenticationClient>
): Promise<ConnectionManager<AuthenticationClient>> {
    const managed = runtimeEffects(options.runtime).runtime;
    const owner = await managed.runPromise(
        Effect.flatMap(Runtime, (service) => Scope.fork(options.scope ?? service.scope))
    );
    const close = () => Effect.runPromise(Scope.close(owner, Exit.void));
    const context = {
        installationId: options.installationId,
        runtime: options.runtime,
        scope: owner,
    };
    let adapter: BackendConnectionAdapter<AuthenticationClient>;
    try {
        adapter = await options.adapter(context);
    } catch (error) {
        await close();
        throw error;
    }
    const baseEgressHandlers = options.egressHandlers ?? createDefaultConnectionEgressHandlers();
    const connections = createLocalCollection<Connection, string>({
        name: "connections",
        getKey: (connection) => connection.userId,
        runtime: options.runtime,
        schemaVersion: 2,
        scope: owner,
    });
    const sessions = new Map<string, ConnectionSession>();
    const wake = Effect.runSync(Queue.sliding<void>(1));
    const notify = () => {
        Queue.offerUnsafe(wake, undefined);
    };
    const lifetime = new AbortController();
    const sockets = new Map<string, Set<WebSocket>>();
    let refreshTask: Promise<Fiber.Fiber<void>> | undefined;
    let unsubscribeConnectivity: (() => void) | undefined;
    let connectionDemand: { unsubscribe(): void } | undefined;
    let disposed = false;

    const updateConnection = async (
        userId: string,
        update: (connection: Connection) => void
    ): Promise<Connection | undefined> => {
        if (!connections.get(userId)) return;
        const transaction = connections.update(userId, { optimistic: false }, update);
        await transaction.isPersisted.promise;
        return connections.get(userId);
    };
    const releaseSession = async (userId: string): Promise<void> => {
        for (const socket of sockets.get(userId) ?? []) socket.close();
        sockets.delete(userId);
        const session = sessions.get(userId);
        sessions.delete(userId);
        await Promise.resolve(session?.cleanup?.());
    };
    const reportUnauthenticated = async (userId: string, error: UnauthenticatedError) => {
        await releaseSession(userId);
        await updateConnection(userId, (connection) => {
            connection.state = {
                status: "needs-auth",
                error: error.message,
            };
        });
    };
    const applyConnection = async <Status extends Connection["state"]["status"]>(
        connection: Connection<Status>
    ): Promise<Connection<Status>> => {
        const record: Connection = {
            ...connection,
            state: connection.state,
        };
        const current = connections.get(connection.userId);
        const transaction = current
            ? connections.update(connection.userId, { optimistic: false }, (draft) => {
                  Object.assign(draft, record);
              })
            : connections.insert(record, { optimistic: false });
        await transaction.isPersisted.promise;
        return connections.get(connection.userId)! as unknown as Connection<Status>;
    };
    const applyEstablishedConnection = async (established: EstablishedConnection): Promise<void> => {
        const { connection, session } = established;
        if (disposed) {
            await session.cleanup?.();
            throw new Error("Connection manager is closed.");
        }
        const userId = connection.userId;
        const previous = sessions.get(userId);
        sessions.set(userId, session);
        try {
            await applyConnection(connection);
        } catch (error) {
            if (previous) {
                sessions.set(userId, previous);
            } else {
                sessions.delete(userId);
            }
            await Promise.resolve(session.cleanup?.());
            throw error;
        }
        if (previous && previous !== session) {
            for (const socket of sockets.get(userId) ?? []) socket.close();
            sockets.delete(userId);
            await Promise.resolve(previous.cleanup?.());
        }
    };
    const refreshDueConnections = async (signal: AbortSignal) => {
        const now = Date.now();
        for (const connection of connections.values()) {
            signal.throwIfAborted();
            const state = connection.state;
            if (state.status !== "active" || state.expiration === undefined) {
                continue;
            }
            const expiresAt = state.expiration.expiresAt;
            if (state.expiration.refreshable) {
                if (
                    expiresAt > now + REFRESH_WINDOW_MS ||
                    options.runtime.connectivity?.isConnected === false
                ) {
                    continue;
                }
                const session = sessions.get(connection.userId);
                if (!session?.refresh) {
                    await updateConnection(connection.userId, (draft) => {
                        draft.state = {
                            status: "error",
                            error: "Connection is refreshable, but its live session does not implement refresh.",
                        };
                    });
                    continue;
                }
                try {
                    const refreshed = await session.refresh({ signal });
                    if (signal.aborted || disposed) {
                        await refreshed.session.cleanup?.();
                        signal.throwIfAborted();
                        return;
                    }
                    if (refreshed.connection.userId !== connection.userId) {
                        throw new Error(
                            `Connection refresh changed user from "${connection.userId}" to "${refreshed.connection.userId}".`
                        );
                    }
                    await applyEstablishedConnection(refreshed);
                } catch (error) {
                    if (signal.aborted || disposed) return;
                    if (isUnauthenticatedError(error)) {
                        await reportUnauthenticated(connection.userId, error);
                    }
                }
                continue;
            } else {
                if (expiresAt <= now) {
                    await reportUnauthenticated(
                        connection.userId,
                        unauthenticated("The connection has expired.")
                    );
                }
                continue;
            }
        }
    };
    const startRefreshLoop = () => {
        if (!isCoordinationHost(options.runtime.coordination)) return;
        const host = options.runtime.coordination;
        const refresh = Effect.tryPromise({
            try: (signal) => host.runAsLeader(({ signal }) => refreshDueConnections(signal), { signal }),
            catch: (cause) => cause,
        }).pipe(
            Effect.withSpan("Connections.refresh"),
            Effect.catch(() => Effect.void)
        );
        refreshTask = managed.runPromise(
            Effect.forkIn(
                Effect.forever(
                    Effect.andThen(Effect.race(Queue.take(wake), Effect.sleep(REFRESH_POLL_MS)), refresh)
                ),
                owner
            )
        );
        void refreshTask.catch(() => undefined);
        unsubscribeConnectivity = options.runtime.connectivity?.subscribe(notify);
    };

    await Effect.runPromise(
        Scope.addFinalizer(
            owner,
            Effect.promise(async () => {
                if (disposed) return;
                disposed = true;
                lifetime.abort();
                unsubscribeConnectivity?.();
                connectionDemand?.unsubscribe();
                const results = await Promise.allSettled([
                    refreshTask?.then((fiber) => Effect.runPromise(Fiber.interrupt(fiber))),
                    Effect.runPromise(Queue.shutdown(wake)),
                ]);
                const users = [...sessions.keys()];
                const released = await Promise.allSettled(users.map(releaseSession));
                const remaining = await Promise.allSettled([
                    Promise.resolve().then(() => adapter.cleanup?.()),
                    connections.cleanup(),
                ]);
                const errors = [...results, ...released, ...remaining].flatMap((result) =>
                    result.status === "rejected" ? [result.reason] : []
                );
                if (errors.length) throw new AggregateError(errors, "Connection cleanup failed.");
            })
        )
    );

    const controller: ConnectionController = {
        async connect(connection) {
            await applyEstablishedConnection(connection);
            notify();
        },
        async disconnect(userId) {
            await releaseSession(userId);
            await updateConnection(userId, (connection) => {
                connection.state = { status: "inactive" };
            });
            notify();
        },
    };
    let authentication: AuthenticationClient;
    try {
        authentication = adapter.createAuthenticationClient(controller);
    } catch (error) {
        await close();
        throw error;
    }

    const manager: ConnectionManager<AuthenticationClient> = {
        installationId: options.installationId,
        authentication,
        connections,
        async disconnect(userId) {
            const session = sessions.get(userId);
            if (session) {
                await session.disconnect();
            }
            await controller.disconnect(userId);
        },
        async forget(userId) {
            const session = sessions.get(userId);
            if (session) {
                await session.disconnect();
            }
            await releaseSession(userId);
            if (!connections.get(userId)) {
                return;
            }
            const transaction = connections.delete(userId, {
                optimistic: false,
            });
            await transaction.isPersisted.promise;
        },
        reportUnauthenticated,
        egress(userId) {
            if (!sessions.get(userId)) return;
            const getHandlers = (): ConnectionEgressHandlers => {
                const session = sessions.get(userId);
                if (!session) {
                    throw new Error(`Connection session for user "${userId}" is unavailable.`);
                }
                return session.egress ? session.egress(baseEgressHandlers) : baseEgressHandlers;
            };
            const handleError = async (error: unknown) => {
                if (isUnauthenticatedError(error)) {
                    await reportUnauthenticated(userId, error);
                }
            };
            return {
                async fetch(input, init) {
                    try {
                        if (disposed) throw new Error("Connection manager is closed.");
                        const request = new Request(input, init);
                        return await getHandlers().fetch(
                            new Request(request, {
                                signal: AbortSignal.any([request.signal, lifetime.signal]),
                            })
                        );
                    } catch (error) {
                        await handleError(error);
                        throw error;
                    }
                },
                async createWebSocket(url, protocols) {
                    try {
                        if (disposed) throw new Error("Connection manager is closed.");
                        const socket = await getHandlers().createWebSocket(url, protocols);
                        if (disposed || !sessions.has(userId)) {
                            socket.close();
                            throw new Error("Connection session is closed.");
                        }
                        let open = sockets.get(userId);
                        if (!open) sockets.set(userId, (open = new Set()));
                        open.add(socket);
                        socket.addEventListener("close", () => open.delete(socket), { once: true });
                        return socket;
                    } catch (error) {
                        await handleError(error);
                        throw error;
                    }
                },
            };
        },
        cleanup: close,
    };

    try {
        // This service consumes every private connection record for restoration
        // and refresh. Keep that local demand alive for the service's scope.
        connectionDemand = connections.subscribeChanges(() => {}, { includeInitialState: true });
        await queryOnce((q) => q.from({ row: connections }));
        const restored = await adapter.restoreConnections({ signal: lifetime.signal });
        if (disposed) {
            await Promise.allSettled(restored.map((entry) => Promise.resolve(entry.session.cleanup?.())));
            throw new Error("Connection manager closed during restoration.");
        }
        const restoredUserIds = new Set<string>();
        for (const established of restored) {
            restoredUserIds.add(established.connection.userId);
            await applyEstablishedConnection(established);
        }
        for (const connection of connections.values()) {
            if (!restoredUserIds.has(connection.userId) && connection.state.status !== "needs-auth") {
                await updateConnection(connection.userId, (draft) => {
                    draft.state = { status: "inactive" };
                });
            }
        }
        startRefreshLoop();
        notify();
        return manager;
    } catch (error) {
        await close();
        throw error;
    }
}
