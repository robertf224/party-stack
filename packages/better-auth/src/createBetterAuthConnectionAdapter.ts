import {
    type BackendConnectionAdapter,
    type BackendConnectionAdapterProvider,
    type Connection,
    type ConnectionController,
    type ConnectionEgressHandlers,
    type ConnectionSession,
    type EstablishedConnection,
    withHttpAuthenticationErrorHandling,
} from "@party-stack/connections";
import { unauthenticated } from "@party-stack/errors";
import { createPartyStackSessionProtocol, PARTY_STACK_SESSION_HEADER } from "./sessionSelection.js";
import type { PartyStackClient } from "./partyStackClient.js";
import type { Session, User } from "better-auth";

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
    return () => {
        const client = options.client;
        const knownUserIds = new Set<string>();

        const listSessions = async (): Promise<DeviceSession[]> => {
            const result = await client.multiSession.listDeviceSessions();
            if (result.error) {
                throw new Error("Failed to list Better Auth sessions.", { cause: result.error });
            }
            return result.data ?? [];
        };

        const createEstablishedConnection = (selected: DeviceSession): EstablishedConnection => {
            const selector = selected.session.id;
            const token = selected.session.token;
            const userId = selected.user.id;
            const connection: Connection<"active"> = {
                userId,
                state: {
                    status: "active",
                    expiration: {
                        expiresAt: selected.session.expiresAt.getTime(),
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
                    return createEstablishedConnection(restored);
                },
                async disconnect() {
                    const result = await client.multiSession.revoke({
                        sessionToken: token,
                    });
                    if (result.error) {
                        throw new Error("Failed to revoke the Better Auth session.", { cause: result.error });
                    }
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
            return (await listSessions()).map(createEstablishedConnection);
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
