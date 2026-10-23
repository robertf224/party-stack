import {
    type BackendConnectionAdapter,
    type BackendConnectionAdapterProvider,
    type Connection,
    type ConnectionController,
    type ConnectionEgressHandlers,
    type ConnectionSession,
    type EstablishedConnection,
    withHttpAuthenticationErrorHandling,
} from "@party-stack/connect";
import { unauthenticated, isUnauthenticatedError } from "@party-stack/errors";
import { Table } from "@party-stack/ontology-storage/tables";
import { Runtime, runtimeEffects } from "@party-stack/runtime";
import { Effect, Predicate, Schema } from "effect";
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
    return ({ runtime, installationId }) => {
        const effects = runtime.tables ? runtimeEffects(runtime).runtime : undefined;
        const table = Table.make<CachedSession>({
            name: JSON.stringify(["better-auth", installationId, "session-selectors"]),
            codec: {
                encode: Schema.encodeSync(CachedSessionSchema),
                decode: Schema.decodeUnknownSync(CachedSessionSchema),
            },
        });
        const cached = async () =>
            effects
                ? effects.runPromise(
                      Effect.flatMap(Runtime, (service) => service.tables.loadSubset(table)).pipe(
                          Effect.map((rows) => rows.map((row) => row.value))
                      )
                  )
                : [];
        const remember = async (selected: readonly DeviceSession[]) => {
            if (!effects) return;
            await effects.runPromise(
                Effect.flatMap(Runtime, (service) =>
                    service.tables.transaction((tx) =>
                        Effect.gen(function* () {
                            yield* tx.clear(table);
                            for (const selectedSession of selected) {
                                const { id, userId, expiresAt } = sessionHandle(selectedSession);
                                // The selector is not a bearer credential; the server still requires its HttpOnly cookie.
                                yield* tx.put(table, id, { id, userId, expiresAt });
                            }
                        })
                    )
                )
            );
        };
        const forget = async (id: string) => {
            if (effects)
                await effects.runPromise(
                    Effect.flatMap(Runtime, (service) => service.tables.delete(table, id))
                );
        };
        const client = options.client;
        const knownUserIds = new Set<string>();

        const listSessions = async (): Promise<DeviceSession[]> => {
            const result = await client.multiSession.listDeviceSessions();
            if (result.error) {
                if (
                    Predicate.isObject(result.error) &&
                    (result.error.status === 401 || result.error.status === 403)
                )
                    throw unauthenticated("Better Auth requires authentication.");
                throw new Error("Failed to list Better Auth sessions.", { cause: result.error });
            }
            const selected = result.data ?? [];
            await remember(selected);
            return selected;
        };

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
                async refresh() {
                    const restored = (await listSessions()).find(
                        (candidate) => candidate.session.id === selector
                    );
                    if (!restored) {
                        throw unauthenticated("The Better Auth session requires authentication.");
                    }
                    return createEstablishedConnection(sessionHandle(restored));
                },
                async disconnect() {
                    const sessionToken =
                        token ??
                        (await listSessions()).find((candidate) => candidate.session.id === selector)?.session
                            .token;
                    if (sessionToken) {
                        const result = await client.multiSession.revoke({ sessionToken });
                        if (result.error)
                            throw new Error("Failed to revoke the Better Auth session.", {
                                cause: result.error,
                            });
                    }
                    await forget(selector);
                    knownUserIds.delete(userId);
                },
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

        const restore = async () => {
            if (runtime.connectivity?.isConnected === false)
                return (await cached()).map(createEstablishedConnection);
            try {
                return (await listSessions()).map((selected) =>
                    createEstablishedConnection(sessionHandle(selected))
                );
            } catch (cause) {
                if (isUnauthenticatedError(cause)) throw cause;
                const local = await cached();
                if (!local.length) throw cause;
                return local.map(createEstablishedConnection);
            }
        };

        let controller: ConnectionController | undefined;
        let unsubscribeSynchronization: (() => void) | undefined;
        const synchronize = async () => {
            if (!controller) return;
            const restored = await restore();
            const restoredUserIds = new Set<string>();
            for (const established of restored) {
                restoredUserIds.add(established.connection.userId);
                await controller.connect(established);
            }
            for (const userId of knownUserIds) {
                if (!restoredUserIds.has(userId)) {
                    await controller.disconnect(userId);
                }
            }
            knownUserIds.clear();
            for (const userId of restoredUserIds) {
                knownUserIds.add(userId);
            }
        };

        const adapter: BackendConnectionAdapter<Client> = {
            name: "better-auth",
            createAuthenticationClient(connectionController) {
                controller = connectionController;
                unsubscribeSynchronization?.();
                unsubscribeSynchronization = client.partyStack.subscribe(synchronize);
                return client;
            },
            async restoreConnections() {
                const restored = await restore();
                knownUserIds.clear();
                for (const { connection } of restored) {
                    knownUserIds.add(connection.userId);
                }
                return restored;
            },
            cleanup() {
                unsubscribeSynchronization?.();
                unsubscribeSynchronization = undefined;
            },
        };
        return adapter;
    };
}
