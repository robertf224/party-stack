import { isUnauthenticatedError, unauthenticated, type UnauthenticatedError } from "@party-stack/errors";
import { createLocalCollection, isCoordinationHost } from "@party-stack/runtime";
import { createSignal, race, run, sleep, until, type Task } from "effection";
import type { RuntimeAdapter } from "@party-stack/runtime";
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
    adapter: BackendConnectionAdapterProvider<AuthenticationClient>;
    egressHandlers?: ConnectionEgressHandlers;
}

export async function createConnectionManager<AuthenticationClient extends object = object>(
    options: CreateConnectionManagerOptions<AuthenticationClient>
): Promise<ConnectionManager<AuthenticationClient>> {
    const context = {
        installationId: options.installationId,
        runtime: options.runtime,
    };
    const adapter: BackendConnectionAdapter<AuthenticationClient> = await options.adapter(context);
    const baseEgressHandlers = options.egressHandlers ?? createDefaultConnectionEgressHandlers();
    const connections = createLocalCollection<Connection, string>({
        name: "connections",
        getKey: (connection) => connection.userId,
        runtime: options.runtime,
        schemaVersion: 2,
    });
    const sessions = new Map<string, ConnectionSession>();
    const wake = createSignal<void, void>();
    let refreshTask: Task<void> | undefined;
    let unsubscribeConnectivity: (() => void) | undefined;
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
            await Promise.resolve(previous.cleanup?.());
        }
    };
    const refreshDueConnections = async () => {
        const now = Date.now();
        for (const connection of connections.values()) {
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
                    const refreshed = await session.refresh();
                    if (refreshed.connection.userId !== connection.userId) {
                        throw new Error(
                            `Connection refresh changed user from "${connection.userId}" to "${refreshed.connection.userId}".`
                        );
                    }
                    await applyEstablishedConnection(refreshed);
                } catch (error) {
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
        refreshTask = run(function* () {
            const wakes = yield* wake;
            while (!disposed) {
                yield* race([sleep(REFRESH_POLL_MS), wakes.next()]);
                if (disposed) return;
                yield* until(host.runAsLeader(() => refreshDueConnections()));
            }
        });
        void refreshTask.catch(() => undefined);
        unsubscribeConnectivity = options.runtime.connectivity?.subscribe(() => {
            wake.send();
        });
    };

    const controller: ConnectionController = {
        async connect(connection) {
            await applyEstablishedConnection(connection);
            wake.send();
        },
        async disconnect(userId) {
            await releaseSession(userId);
            await updateConnection(userId, (connection) => {
                connection.state = { status: "inactive" };
            });
            wake.send();
        },
    };
    const authentication = adapter.createAuthenticationClient(controller);

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
            const transaction =
                connections.delete(userId, {
                    optimistic: false,
                });
            await transaction.isPersisted
                .promise;
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
                        return await getHandlers().fetch(new Request(input, init));
                    } catch (error) {
                        await handleError(error);
                        throw error;
                    }
                },
                async createWebSocket(url, protocols) {
                    try {
                        return await getHandlers().createWebSocket(url, protocols);
                    } catch (error) {
                        await handleError(error);
                        throw error;
                    }
                },
            };
        },
        async cleanup() {
            if (disposed) return;
            disposed = true;
            wake.close();
            unsubscribeConnectivity?.();
            if (refreshTask) await refreshTask.halt();
            const live = [...sessions.values()];
            sessions.clear();
            await Promise.all(live.map((session) => Promise.resolve(session.cleanup?.())));
            await Promise.resolve(adapter.cleanup?.());
            await connections.cleanup();
        },
    };

    try {
        await connections.preload();
        const restored = await adapter.restoreConnections();
        const restoredUserIds = new Set<string>();
        for (const established of restored) {
            restoredUserIds.add(established.connection.userId);
            await applyEstablishedConnection(established);
        }
        for (const connection of connections.values()) {
            if (
                !restoredUserIds.has(
                    connection.userId
                ) &&
                connection.state.status !==
                    "needs-auth"
            ) {
                await updateConnection(connection.userId, (draft) => {
                    draft.state = { status: "inactive" };
                });
            }
        }
        startRefreshLoop();
        wake.send();
        return manager;
    } catch (error) {
        wake.close();
        const live = [...sessions.values()];
        sessions.clear();
        await Promise.all(live.map((session) => Promise.resolve(session.cleanup?.())));
        await Promise.resolve(adapter.cleanup?.());
        await connections.cleanup();
        throw error;
    }
}
