import { unauthenticated, type UnauthenticatedError } from "@party-stack/errors";
import { Table } from "@party-stack/ontology-storage/tables";
import { makeLocalCollection, Runtime, getRuntime } from "@party-stack/runtime";
import { queryOnce } from "@tanstack/db";
import { Clock, Context, Effect, Exit, Fiber, Layer, Queue, Scope, Semaphore, Stream } from "effect";
import { ConnectionError, connectionOperation } from "./ConnectionError.js";
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
import type { RuntimeAdapter } from "@party-stack/runtime";

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
    runtime: RuntimeAdapter;
    scope?: Scope.Scope;
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
        runtime: runtime.adapter,
        scope: owner,
    });
    yield* Effect.addFinalizer(() => adapter.cleanup?.() ?? Effect.void);
    const connections = yield* makeLocalCollection<Connection, string>({
        name: "connections",
        getKey: (connection) => connection.userId,
        schemaVersion: 2,
    });
    const sessions = new Map<string, ConnectionSession>();
    const sessionStates = new Map<string, string>();
    const sockets = new Map<string, Set<WebSocket>>();
    const locks = new Map<string, { state: Semaphore.Semaphore; command: Semaphore.Semaphore }>();
    const locked = <B, E>(userId: string, work: Effect.Effect<B, E>, mode: "state" | "command" = "state") =>
        Effect.suspend(() => {
            let lock = locks.get(userId);
            if (!lock)
                locks.set(
                    userId,
                    (lock = { state: Semaphore.makeUnsafe(1), command: Semaphore.makeUnsafe(1) })
                );
            return lock[mode].withPermit(work);
        });
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
        sessionStates.delete(userId);
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
        if (!connections.has(userId)) return;
        yield* connectionOperation(
            "persist",
            () => connections.update(userId, { optimistic: false }, update).isPersisted.promise
        );
    });
    const adoptSession = Effect.fnUntraced(function* (
        { connection, session }: EstablishedConnection,
        adopted?: () => void
    ) {
        if (disposed) return yield* closed();
        const previous = sessions.get(connection.userId);
        sessions.set(connection.userId, session);
        sessionStates.set(connection.userId, JSON.stringify(connection.state));
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
        yield* connectionOperation("persist", () => {
            if (JSON.stringify(connections.get(connection.userId)) === JSON.stringify(connection))
                return Promise.resolve();
            const transaction = connections.has(connection.userId)
                ? connections.update(connection.userId, { optimistic: false }, (draft) => {
                      Object.assign(draft, connection);
                  })
                : connections.insert(connection, { optimistic: false });
            return transaction.isPersisted.promise.then(() => undefined);
        });
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
        yield* releaseSession(userId);
        yield* updateConnection(userId, (row) => {
            row.state = { status: "needs-auth", error: error.message };
        });
    });
    const reportUnauthenticated = (userId: string, error: UnauthenticatedError) =>
        owned(locked(userId, markUnauthenticated(userId, error)));
    const controller: ConnectionController = {
        connect: (entry) =>
            handoff(entry, (adopted) =>
                owned(locked(entry.connection.userId, applyEstablished(entry, adopted))).pipe(
                    Effect.tap(() => Effect.sync(notify))
                )
            ),
        disconnect: (userId) =>
            owned(
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
            ),
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
            if (expiresAt > now + REFRESH_WINDOW_MS || !(yield* runtime.online)) continue;
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
                            if (forget) {
                                if (connections.has(userId))
                                    yield* connectionOperation(
                                        "forget",
                                        () =>
                                            connections.delete(userId, { optimistic: false }).isPersisted
                                                .promise
                                    );
                            } else
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
    const manager: ConnectionManagerService<A> = {
        installationId: options.installationId,
        authentication,
        connections,
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
    yield* Effect.acquireRelease(
        Effect.sync(() => connections.subscribeChanges(() => {}, { includeInitialState: true })),
        (demand) => Effect.sync(() => demand.unsubscribe())
    );
    yield* connectionOperation("restore", () => queryOnce((q) => q.from({ row: connections })));
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
    const connectionTable = Table.make<Connection>({
        name: JSON.stringify(["local", runtime.adapter.owner, runtime.adapter.namespace, "connections"]),
        version: 2,
    });
    // Credentials are shared transactionally; SDK clients and sockets belong to their context.
    // Restore a local handle after another context signs in, and close it after remote logout.
    const reconcile = Effect.fn("Connections.reconcile")(function* () {
        const rows = yield* runtime.tables
            .loadSubset(connectionTable)
            .pipe(Effect.mapError((cause) => ConnectionError.from("restore", cause)));
        const activeRows = rows.filter(({ value }) => value.state.status === "active");
        const active = new Set(activeRows.map(({ value }) => value.userId));
        for (const id of sessions.keys()) if (!active.has(id)) yield* locked(id, releaseSession(id));
        const changed = new Set(
            activeRows
                .filter(
                    ({ value }) =>
                        !sessions.has(value.userId) ||
                        sessionStates.get(value.userId) !== JSON.stringify(value.state)
                )
                .map(({ value }) => value.userId)
        );
        if (!changed.size) return;
        yield* Effect.uninterruptibleMask((restore) =>
            Effect.flatMap(restore(adapter.restoreConnections()), (entries) =>
                Effect.forEach(
                    entries,
                    (entry) =>
                        handoff(entry, (adopted) =>
                            locked(
                                entry.connection.userId,
                                Effect.gen(function* () {
                                    if (!changed.has(entry.connection.userId)) return;
                                    const current = yield* runtime.tables
                                        .get(connectionTable, entry.connection.userId)
                                        .pipe(
                                            Effect.mapError((cause) => ConnectionError.from("restore", cause))
                                        );
                                    // This is a projection of shared state. A late restore must never
                                    // persist an old active status over another context's logout.
                                    if (current?.state.status === "active")
                                        yield* adoptSession(
                                            {
                                                ...entry,
                                                connection: {
                                                    ...current,
                                                    state: current.state as Connection<"active">["state"],
                                                },
                                            },
                                            adopted
                                        );
                                })
                            )
                        ),
                    { discard: true }
                )
            )
        );
    });
    yield* Stream.runForEach(runtime.externalChanges, () =>
        reconcile().pipe(
            Effect.catch((error) =>
                Effect.logWarning("Connection reconciliation failed", { kind: error.kind })
            )
        )
    ).pipe(Effect.forkScoped);
    yield* Effect.forever(
        Effect.andThen(
            Effect.race(Queue.take(wake), Effect.sleep(REFRESH_POLL_MS)),
            refresh().pipe(
                Effect.catch((error) => Effect.logWarning("Connection refresh failed", { kind: error.kind }))
            )
        )
    ).pipe(Effect.forkScoped);
    yield* Stream.runForEach(runtime.connectivity, () => Effect.sync(notify)).pipe(Effect.forkScoped);
    // Close the door before interrupting work and releasing sessions.
    yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
            disposed = true;
            lifetime.abort();
        })
    );
    notify();
    return manager;
});

/** Framework boundary: all implementation work above runs as scoped Effects. */
export async function createConnectionManager<A extends object = object>(
    options: CreateConnectionManagerOptions<A>
): Promise<ConnectionManager<A>> {
    const managed = { runPromise: Effect.runPromiseWith(getRuntime(options.runtime).context) };
    const owner = await managed.runPromise(
        Effect.gen(function* () {
            const runtime = yield* Runtime;
            const scope = yield* Scope.fork(runtime.scope);
            if (options.scope) yield* Scope.addFinalizer(options.scope, Scope.close(scope, Exit.void));
            return scope;
        })
    );
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
