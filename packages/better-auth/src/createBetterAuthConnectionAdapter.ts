import {
    connectionOperation,
    ConnectionError,
    type BackendConnectionAdapter,
    type BackendConnectionAdapterProvider,
    type Connection,
    type ConnectionController,
    type ConnectionEgressHandlers,
    type ConnectionSession,
    type EstablishedConnection,
    withHttpAuthenticationErrorHandling,
} from "@party-stack/connect";
import { unauthenticated } from "@party-stack/ontology-backend";
import { Table } from "@party-stack/ontology-storage/tables";
import { Runtime } from "@party-stack/runtime";
import { Clock, Effect, Fiber, Predicate, Schema, Semaphore } from "effect";
import { createPartyStackSessionProtocol, PARTY_STACK_SESSION_HEADER } from "./sessionSelection.js";
import type { PartyStackClient } from "./partyStackClient.js";
import type { Session, User } from "better-auth";

const CachedSessionSchema = Schema.Struct({
    id: Schema.String,
    userId: Schema.String,
    expiresAt: Schema.Finite,
});
type CachedSession = typeof CachedSessionSchema.Type;
type SessionHandle = CachedSession & { readonly token?: string };
const sessionHandle = (selected: DeviceSession): SessionHandle => ({
    id: selected.session.id,
    userId: selected.user.id,
    expiresAt: selected.session.expiresAt.getTime(),
    token: selected.session.token,
});

interface DeviceSession {
    session: Session;
    user: User;
}

interface BetterAuthResult<Data = unknown> {
    data?: Data | null;
    error?: unknown;
}

export interface BetterAuthConnectionClient {
    readonly signIn: object;
    readonly signUp?: object;
    readonly signOut?: (...args: never[]) => Promise<unknown>;
    readonly multiSession: {
        listDeviceSessions(): Promise<BetterAuthResult<DeviceSession[]>>;
        revoke(input: { sessionToken: string }): Promise<BetterAuthResult>;
    };
    readonly partyStack: PartyStackClient;
}

export interface CreateBetterAuthConnectionAdapterOptions<Client extends BetterAuthConnectionClient> {
    client: Client;
}

export function createBetterAuthConnectionAdapter<Client extends BetterAuthConnectionClient>(
    options: CreateBetterAuthConnectionAdapterOptions<Client>
): BackendConnectionAdapterProvider<Client> {
    return Effect.fn("BetterAuth.connections")(function* ({ installationId }) {
        const service = yield* Runtime;
        const scope = yield* Effect.scope;
        const context = yield* Effect.context<never>();
        const run = Effect.runPromiseWith(context);
        const table = Table.make<CachedSession>({
            name: JSON.stringify(["better-auth", installationId, "session-selectors"]),
            codec: {
                encode: Schema.encodeSync(CachedSessionSchema),
                decode: Schema.decodeUnknownSync(CachedSessionSchema),
            },
        });
        const cached = service.tables.loadSubset(table).pipe(
            Effect.map((rows) => rows.map((row) => row.value)),
            Effect.mapError((cause) => ConnectionError.from("restore", cause))
        );
        const remember = (selected: readonly DeviceSession[]) =>
            service.tables
                .transaction((tx) =>
                    Effect.gen(function* () {
                        yield* tx.clear(table);
                        for (const selectedSession of selected) {
                            const { id, userId, expiresAt } = sessionHandle(selectedSession);
                            // A selector isn't a bearer credential; the server still requires its HttpOnly cookie.
                            yield* tx.put(table, id, { id, userId, expiresAt });
                        }
                    })
                )
                .pipe(Effect.mapError((cause) => ConnectionError.from("persist", cause)));
        const forget = (id: string) =>
            service.tables
                .delete(table, id)
                .pipe(Effect.mapError((cause) => ConnectionError.from("forget", cause)));
        const client = options.client;
        const knownUserIds = new Set<string>();

        const listSessions = Effect.fn("BetterAuth.sessions")(function* () {
            const result = yield* connectionOperation("list-sessions", () =>
                client.multiSession.listDeviceSessions()
            );
            if (result.error) {
                return yield* ConnectionError.from(
                    "list-sessions",
                    Predicate.isObject(result.error) &&
                        (result.error.status === 401 || result.error.status === 403)
                        ? unauthenticated("Better Auth requires authentication.")
                        : result.error
                );
            }
            const selected = result.data ?? [];
            yield* remember(selected);
            return selected;
        });

        const createEstablishedConnection = (selected: SessionHandle): EstablishedConnection => {
            const selector = selected.id;
            const token = selected.token;
            const userId = selected.userId;
            const connection: Connection<"active"> = {
                userId,
                state: {
                    status: "active",
                    expiration: {
                        expiresAt: selected.expiresAt,
                        refreshable: true,
                    },
                },
            };
            const session: ConnectionSession = {
                refresh: Effect.fn("BetterAuth.refresh")(function* () {
                    const restored = (yield* listSessions()).find(
                        (candidate) => candidate.session.id === selector
                    );
                    if (!restored)
                        return yield* ConnectionError.from(
                            "refresh",
                            unauthenticated("The Better Auth session requires authentication.")
                        );
                    return createEstablishedConnection(sessionHandle(restored));
                }),
                disconnect: Effect.fn("BetterAuth.disconnect")(function* () {
                    const sessionToken =
                        token ??
                        (yield* listSessions()).find((candidate) => candidate.session.id === selector)
                            ?.session.token;
                    if (sessionToken) {
                        const result = yield* connectionOperation("revoke", () =>
                            client.multiSession.revoke({ sessionToken })
                        );
                        if (result.error) return yield* ConnectionError.from("revoke", result.error);
                    }
                    yield* forget(selector);
                    knownUserIds.delete(userId);
                }),
                egress(handlers) {
                    return withHttpAuthenticationErrorHandling({
                        async fetch(request) {
                            const headers = new Headers(request.headers);
                            headers.set(PARTY_STACK_SESSION_HEADER, selector);
                            return handlers.fetch(
                                new Request(request, {
                                    headers,
                                })
                            );
                        },
                        createWebSocket(url, protocols) {
                            const requested = Array.isArray(protocols)
                                ? protocols
                                : protocols
                                  ? [protocols]
                                  : [];
                            return handlers.createWebSocket(url, [
                                createPartyStackSessionProtocol(selector),
                                ...requested,
                            ]);
                        },
                    } satisfies ConnectionEgressHandlers);
                },
            };
            return { connection, session };
        };

        const localSessions = Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            return (yield* cached).filter((row) => row.expiresAt > now).map(createEstablishedConnection);
        });
        const restore = Effect.fn("BetterAuth.restore")(function* () {
            if (!(yield* service.connectivity.online)) return yield* localSessions;
            return yield* listSessions().pipe(
                Effect.map((sessions) =>
                    sessions.map((selected) => createEstablishedConnection(sessionHandle(selected)))
                ),
                Effect.catch((error) =>
                    error.kind === "Unauthenticated"
                        ? Effect.fail(error)
                        : Effect.flatMap(localSessions, (local) =>
                              local.length ? Effect.succeed(local) : Effect.fail(error)
                          )
                )
            );
        });
        let controller: ConnectionController | undefined;
        let unsubscribeSynchronization: (() => void) | undefined;
        const synchronization = yield* Semaphore.make(1);
        const synchronize = synchronization.withPermit(
            Effect.gen(function* () {
                if (!controller) return;
                const restored = yield* restore();
                const restoredUserIds = new Set<string>();
                for (const established of restored) {
                    restoredUserIds.add(established.connection.userId);
                    yield* controller.connect(established);
                }
                for (const userId of knownUserIds)
                    if (!restoredUserIds.has(userId)) yield* controller.disconnect(userId);
                knownUserIds.clear();
                for (const userId of restoredUserIds) knownUserIds.add(userId);
            })
        );
        yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
                unsubscribeSynchronization?.();
                unsubscribeSynchronization = undefined;
            })
        );
        const adapter: BackendConnectionAdapter<Client> = {
            name: "better-auth",
            createAuthenticationClient(connectionController) {
                controller = connectionController;
                unsubscribeSynchronization?.();
                unsubscribeSynchronization = client.partyStack.subscribe(() =>
                    run(Effect.flatMap(Effect.forkIn(synchronize, scope), Fiber.join))
                );
                return client;
            },
            restoreConnections: Effect.fn("BetterAuth.restoreConnections")(function* () {
                const restored = yield* restore();
                knownUserIds.clear();
                for (const { connection } of restored) knownUserIds.add(connection.userId);
                return restored;
            }),
        };
        return adapter;
    });
}
