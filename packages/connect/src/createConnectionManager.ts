import { unauthenticated, type UnauthenticatedError } from "@party-stack/ontology-backend";
import { Table } from "@party-stack/ontology-storage/tables";
import { Runtime } from "@party-stack/runtime";
import { Clock, Context, Effect, Exit, Fiber, Layer, Queue, RcMap, Scope, Semaphore, Stream } from "effect";
import { ConnectionError } from "./ConnectionError.js";
import { createDefaultConnectionEgressHandlers } from "./createDefaultConnectionEgressHandlers.js";
import type {
    BackendConnectionAdapterProvider,
    Connection,
    ConnectionController,
    ConnectionEgressHandlers,
    ConnectionManager,
    ConnectionManagerService,
    ConnectionSession,
    EstablishedConnection,
} from "./types.js";
import type { OntologyStorageError } from "@party-stack/ontology-storage";
import type { Transaction } from "@party-stack/ontology-storage/tables";
import type { RuntimeService } from "@party-stack/runtime";

const REFRESH_POLL_MS = 30_000;
const REFRESH_WINDOW_MS = 60_000;

export interface ConnectionManagerOptions<AuthenticationClient extends object = object> {
    installationId: string;
    adapter: BackendConnectionAdapterProvider<AuthenticationClient>;
    egressHandlers?: ConnectionEgressHandlers;
}

export interface CreateConnectionManagerOptions<
    A extends object = object,
> extends ConnectionManagerOptions<A> {
    runtime: RuntimeService;
    scope: Scope.Scope;
}

export class Connections extends Context.Service<Connections, ConnectionManagerService>()(
    "@party-stack/connect/Connections"
) {
    static readonly layer = (options: ConnectionManagerOptions) =>
        Layer.effect(Connections, makeConnectionManager(options));
}

/** Owns sessions and refresh fibers in the caller's scope. SDK authentication clients remain generic. */
export const makeConnectionManager = Effect.fn("Connections.make")(function* <A extends object = object>(
    options: ConnectionManagerOptions<A>
): Effect.fn.Return<ConnectionManagerService<A>, ConnectionError, Runtime | Scope.Scope> {
    const runtime = yield* Runtime;
    const owner = yield* Effect.scope;
    const context = yield* Effect.context<never>();
    const run = Effect.runPromiseWith(context);
    let disposed = false;
    const lifetime = new AbortController();
    const adapter = yield* options.adapter({
        installationId: options.installationId,
    });
    yield* Effect.addFinalizer(() => adapter.cleanup?.() ?? Effect.void);
    const connectionTable = Table.make<Connection>({
        name: JSON.stringify(["local", runtime.owner, runtime.namespace, "connections"]),
        version: 2,
    });
    const connections = new Map<string, Connection>();
    const connectionListeners = new Set<() => void>();
    let connectionVersion = 0;
    const listeners = new Map<string, Set<(state: Connection["state"]) => void>>();
    const stateGate = yield* Semaphore.make(1);
    const installState = Effect.fnUntraced(function* (rows: readonly { value: Connection }[]) {
        const next = new Map(rows.map(({ value }) => [value.userId, value]));
        const changed: string[] = [];
        for (const userId of new Set([...connections.keys(), ...next.keys()])) {
            if (JSON.stringify(connections.get(userId)) === JSON.stringify(next.get(userId))) continue;
            const value = next.get(userId);
            if (value) connections.set(userId, value);
            else connections.delete(userId);
            changed.push(userId);
        }
        for (const userId of changed) {
            const state = connections.get(userId)?.state ?? { status: "inactive" as const };
            for (const listener of listeners.get(userId) ?? [])
                yield* Effect.try({ try: () => listener(state), catch: () => undefined }).pipe(
                    Effect.catch(() => Effect.logWarning("Connection state subscriber failed"))
                );
        }
        if (changed.length) for (const listener of connectionListeners) listener();
    });
    const reloadState = stateGate.withPermit(
        runtime.tables.query(connectionTable).pipe(
            Effect.mapError((cause) => ConnectionError.from("restore", cause)),
            Effect.tap(installState)
        )
    );
    const persistState = <B>(body: (tx: Transaction) => Effect.Effect<B, OntologyStorageError>) =>
        stateGate.withPermit(
            Effect.gen(function* () {
                const rows = yield* runtime.tables
                    .transaction((tx) =>
                        Effect.gen(function* () {
                            yield* body(tx);
                            return yield* tx.query(connectionTable);
                        })
                    )
                    .pipe(Effect.mapError((cause) => ConnectionError.from("persist", cause)));
                yield* installState(rows);
            })
        );
    const sessions = new Map<string, ConnectionSession>();
    const sockets = new Map<string, Set<WebSocket>>();
    const locks = yield* RcMap.make({
        lookup: () =>
            Effect.gen(function* () {
                return { state: yield* Semaphore.make(1), command: yield* Semaphore.make(1) };
            }),
    });
    const locked = <B, E>(userId: string, work: Effect.Effect<B, E>, mode: "state" | "command" = "state") =>
        Effect.scoped(Effect.flatMap(RcMap.get(locks, userId), (lock) => lock[mode].withPermit(work)));
    const wake = yield* Queue.sliding<void>(1);
    yield* Effect.addFinalizer(() => Queue.shutdown(wake));
    const notify = () => {
        Queue.offerUnsafe(wake, undefined);
    };
    const closed = () =>
        new ConnectionError({
            operation: "lifecycle",
            kind: "Closed",
            message: "Connection manager is closed.",
        });
    // Every external operation is a child fiber, including callbacks from SDKs.
    const owned = <B>(work: Effect.Effect<B, ConnectionError>) =>
        Effect.suspend(() =>
            disposed ? Effect.fail(closed()) : Effect.flatMap(Effect.forkIn(work, owner), Fiber.join)
        );
    const closeSockets = (userId: string) =>
        Effect.sync(() => {
            for (const socket of sockets.get(userId) ?? []) socket.close();
            sockets.delete(userId);
        });
    const releaseSession = Effect.fnUntraced(function* (userId: string) {
        yield* closeSockets(userId);
        const session = sessions.get(userId);
        sessions.delete(userId);
        yield* session?.cleanup?.() ?? Effect.void;
    });
    yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
            const exits = yield* Effect.forEach(
                [...sessions.keys()],
                (id) => Effect.exit(releaseSession(id)),
                { concurrency: "unbounded" }
            );
            for (const exit of exits) yield* exit;
        })
    );
    const updateConnection = Effect.fnUntraced(function* (userId: string, update: (row: Connection) => void) {
        yield* persistState((tx) =>
            Effect.gen(function* () {
                const current = yield* tx.get(connectionTable, userId);
                if (!current) return;
                const row = connectionTable.decode(connectionTable.encode(current));
                update(row);
                yield* tx.put(connectionTable, userId, row);
            })
        );
    });
    const adoptSession = Effect.fnUntraced(function* (
        { connection, session }: EstablishedConnection,
        adopted?: () => void
    ) {
        if (disposed) return yield* closed();
        const previous = sessions.get(connection.userId);
        sessions.set(connection.userId, session);
        adopted?.();
        if (previous && previous !== session) {
            yield* closeSockets(connection.userId);
            yield* previous.cleanup?.() ?? Effect.void;
        }
    }, Effect.uninterruptible);
    const applyEstablished = Effect.fnUntraced(function* (
        entry: EstablishedConnection,
        adopted?: () => void
    ) {
        if (disposed) return yield* closed();
        const { connection } = entry;
        // Persistence and replacing the live session form one uninterruptible handoff.
        // If persistence fails the old session is still live.
        yield* persistState((tx) => tx.put(connectionTable, connection.userId, connection));
        yield* adoptSession(entry, adopted);
    }, Effect.uninterruptible);
    // Until a session is adopted, the submitting fiber owns it. This also covers
    // cancellation while waiting for another operation on the same user.
    const handoff = (
        entry: EstablishedConnection,
        use: (adopted: () => void) => Effect.Effect<void, ConnectionError>,
        alreadyOwned = false
    ) =>
        Effect.suspend(() => {
            let adopted = alreadyOwned || sessions.get(entry.connection.userId) === entry.session;
            return Effect.acquireUseRelease(
                Effect.void,
                () =>
                    use(() => {
                        adopted = true;
                    }),
                () => (adopted ? Effect.void : (entry.session.cleanup?.() ?? Effect.void))
            );
        });
    const markUnauthenticated = Effect.fnUntraced(function* (userId: string, error: UnauthenticatedError) {
        connectionVersion++;
        yield* releaseSession(userId);
        yield* updateConnection(userId, (row) => {
            row.state = { status: "needs-auth", error: error.message };
        });
    });
    const reportUnauthenticated = (userId: string, error: UnauthenticatedError) =>
        owned(locked(userId, markUnauthenticated(userId, error)));
    const controller: ConnectionController = {
        connect: (entry) =>
            Effect.suspend(() => {
                connectionVersion++;
                return handoff(entry, (adopted) =>
                    owned(locked(entry.connection.userId, applyEstablished(entry, adopted))).pipe(
                        Effect.tap(() => Effect.sync(notify))
                    )
                );
            }),
        disconnect: (userId) =>
            Effect.suspend(() => {
                connectionVersion++;
                return owned(
                    locked(
                        userId,
                        Effect.gen(function* () {
                            yield* releaseSession(userId);
                            yield* updateConnection(userId, (row) => {
                                row.state = { status: "inactive" };
                            });
                            notify();
                        })
                    )
                );
            }),
    };
    const authentication = yield* Effect.try({
        try: () => adapter.createAuthenticationClient(controller),
        catch: (cause) => ConnectionError.from("authentication", cause),
    });
    const refresh = Effect.fn("Connections.refresh")(function* () {
        const now = yield* Clock.currentTimeMillis;
        for (const connection of connections.values()) {
            const state = connection.state;
            if (state.status !== "active" || !state.expiration) continue;
            const { expiresAt, refreshable } = state.expiration;
            const previous = sessions.get(connection.userId);
            if (!refreshable) {
                if (expiresAt <= now)
                    yield* reportUnauthenticated(
                        connection.userId,
                        unauthenticated("The connection has expired.")
                    );
                continue;
            }
            if (expiresAt > now + REFRESH_WINDOW_MS || !(yield* runtime.connectivity.online)) continue;
            if (!previous?.refresh) {
                yield* locked(
                    connection.userId,
                    updateConnection(connection.userId, (row) => {
                        row.state = {
                            status: "error",
                            error: "Connection is refreshable, but its live session does not implement refresh.",
                        };
                    })
                );
                continue;
            }
            yield* Effect.uninterruptibleMask((restore) =>
                Effect.flatMap(restore(previous.refresh!()), (next) =>
                    handoff(
                        next,
                        (adopted) =>
                            restore(
                                locked(
                                    connection.userId,
                                    Effect.suspend(() => {
                                        if (disposed || sessions.get(connection.userId) !== previous)
                                            return Effect.void;
                                        if (next.connection.userId !== connection.userId)
                                            return Effect.fail(
                                                new ConnectionError({
                                                    operation: "refresh",
                                                    kind: "InvalidState",
                                                    message: "Connection refresh changed user identity.",
                                                })
                                            );
                                        return applyEstablished(next, adopted);
                                    })
                                )
                            ),
                        next.session === previous
                    )
                )
            ).pipe(
                Effect.catch((error) =>
                    error.kind === "Unauthenticated"
                        ? locked(
                              connection.userId,
                              Effect.suspend(() =>
                                  sessions.get(connection.userId) === previous
                                      ? markUnauthenticated(connection.userId, unauthenticated(error.message))
                                      : Effect.void
                              )
                          )
                        : Effect.logWarning("Connection refresh failed", {
                              operation: error.operation,
                              kind: error.kind,
                          })
                )
            );
        }
    });
    const base = options.egressHandlers ?? createDefaultConnectionEgressHandlers();
    const logout = (userId: string, forget: boolean) =>
        owned(
            locked(
                userId,
                Effect.gen(function* () {
                    connectionVersion++;
                    const session = sessions.get(userId);
                    // SDK logout may await a controller callback. Only local state transitions
                    // take the state lock; commands serialize separately to avoid reentrancy deadlocks.
                    yield* session?.disconnect() ?? Effect.void;
                    yield* locked(
                        userId,
                        Effect.gen(function* () {
                            const current = sessions.get(userId);
                            if (current && current !== session) return;
                            yield* releaseSession(userId);
                            if (forget) yield* persistState((tx) => tx.delete(connectionTable, userId));
                            else
                                yield* updateConnection(userId, (row) => {
                                    row.state = { status: "inactive" };
                                });
                            notify();
                        })
                    );
                }),
                "command"
            )
        );
    const refreshConnections = Effect.fn("Connections.restore")(function* () {
        const observed = connectionVersion;
        const entries = yield* adapter.restoreConnections();
        const present = new Set(entries.map((entry) => entry.connection.userId));
        for (const entry of entries)
            yield* handoff(entry, (adopted) =>
                locked(
                    entry.connection.userId,
                    observed === connectionVersion ? applyEstablished(entry, adopted) : Effect.void
                )
            );
        if (observed !== connectionVersion) return;
        for (const id of sessions.keys())
            if (!present.has(id))
                yield* locked(
                    id,
                    Effect.gen(function* () {
                        if (observed !== connectionVersion) return;
                        yield* releaseSession(id);
                        yield* updateConnection(id, (row) => {
                            row.state = { status: "inactive" };
                        });
                    })
                );
    });
    const connectionChanges = Stream.callback<readonly Connection[]>(
        (queue) =>
            Effect.acquireRelease(
                Effect.sync(() => {
                    const emit = () => {
                        Queue.offerUnsafe(queue, [...connections.values()]);
                    };
                    connectionListeners.add(emit);
                    emit();
                    return emit;
                }),
                (emit) =>
                    Effect.sync(() => {
                        connectionListeners.delete(emit);
                    })
            ),
        { bufferSize: 1, strategy: "sliding" }
    );
    const manager: ConnectionManagerService<A> = {
        installationId: options.installationId,
        authentication,
        connections,
        connectionChanges,
        refreshConnections: () => owned(refreshConnections()),
        subscribeConnection(userId, listener) {
            if (disposed) return () => {};
            let subscribers = listeners.get(userId);
            if (!subscribers) listeners.set(userId, (subscribers = new Set()));
            subscribers.add(listener);
            return () => {
                subscribers.delete(listener);
                if (!subscribers.size) listeners.delete(userId);
            };
        },
        reportUnauthenticated,
        disconnect: (userId) => logout(userId, false),
        forget: (userId) => logout(userId, true),
        egress(userId) {
            if (disposed || !sessions.has(userId) || connections.get(userId)?.state.status !== "active")
                return;
            const handlers = () => {
                const session = sessions.get(userId);
                if (!session || disposed) throw closed();
                return session.egress?.(base) ?? base;
            };
            const handleError = async (cause: unknown, session: ConnectionSession | undefined) => {
                const error = ConnectionError.from("egress", cause);
                if (error.kind === "Unauthenticated" && !disposed)
                    await run(
                        owned(
                            locked(
                                userId,
                                Effect.suspend(() =>
                                    sessions.get(userId) === session
                                        ? markUnauthenticated(userId, unauthenticated(error.message))
                                        : Effect.void
                                )
                            )
                        )
                    );
                throw cause;
            };
            return {
                async fetch(input, init) {
                    const session = sessions.get(userId);
                    try {
                        const request = new Request(input, init);
                        return await handlers().fetch(
                            new Request(request, {
                                signal: AbortSignal.any([request.signal, lifetime.signal]),
                            })
                        );
                    } catch (cause) {
                        return handleError(cause, session);
                    }
                },
                async createWebSocket(url, protocols) {
                    const session = sessions.get(userId);
                    try {
                        const socket = await handlers().createWebSocket(url, protocols);
                        if (disposed || sessions.get(userId) !== session) {
                            socket.close();
                            throw closed();
                        }
                        let open = sockets.get(userId);
                        if (!open) sockets.set(userId, (open = new Set()));
                        open.add(socket);
                        socket.addEventListener("close", () => open.delete(socket), { once: true });
                        return socket;
                    } catch (cause) {
                        return handleError(cause, session);
                    }
                },
            };
        },
    };
    yield* reloadState;
    // Register restored session ownership before any fallible metadata writes.
    const restored = yield* adapter.restoreConnections();
    for (const entry of restored) sessions.set(entry.connection.userId, entry.session);
    for (const entry of restored) yield* applyEstablished(entry);
    const restoredIds = new Set(restored.map((entry) => entry.connection.userId));
    for (const connection of connections.values())
        if (!restoredIds.has(connection.userId) && connection.state.status !== "needs-auth") {
            yield* updateConnection(connection.userId, (row) => {
                row.state = { status: "inactive" };
            });
        }
    yield* Effect.forever(
        Effect.andThen(
            Effect.race(Queue.take(wake), Effect.sleep(REFRESH_POLL_MS)),
            refresh().pipe(
                Effect.catch((error) => Effect.logWarning("Connection refresh failed", { kind: error.kind }))
            )
        )
    ).pipe(Effect.forkScoped);
    yield* Stream.runForEach(runtime.connectivity.changes, () => Effect.sync(notify)).pipe(Effect.forkScoped);
    // Close the door before interrupting work and releasing sessions.
    yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
            disposed = true;
            lifetime.abort();
            connections.clear();
            listeners.clear();
            connectionListeners.clear();
        })
    );
    notify();
    return manager;
});

/** Framework boundary: all implementation work above runs as scoped Effects. */
export async function createConnectionManager<A extends object = object>(
    options: CreateConnectionManagerOptions<A>
): Promise<ConnectionManager<A>> {
    const managed = { runPromise: Effect.runPromiseWith(Context.make(Runtime, options.runtime)) };
    const owner = await Effect.runPromise(Scope.fork(options.scope));
    try {
        const manager = await managed.runPromise(
            Effect.flatMap(
                Effect.forkIn(Scope.provide(makeConnectionManager(options), owner), owner),
                Fiber.join
            )
        );
        let closing: Promise<void> | undefined;
        return {
            ...manager,
            refreshConnections: () => managed.runPromise(manager.refreshConnections()),
            disconnect: (id) => managed.runPromise(manager.disconnect(id)),
            forget: (id) => managed.runPromise(manager.forget(id)),
            reportUnauthenticated: (id, error) =>
                managed.runPromise(manager.reportUnauthenticated(id, error)),
            cleanup: () => (closing ??= Effect.runPromise(Scope.close(owner, Exit.void))),
        };
    } catch (cause) {
        await Effect.runPromise(Scope.close(owner, Exit.fail(cause)));
        throw cause;
    }
}
