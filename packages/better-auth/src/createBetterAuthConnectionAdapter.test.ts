import { describe, expect, it, vi } from "vitest";
import type { EstablishedConnection } from "@party-stack/connections";
import {
    createBetterAuthConnectionAdapter,
    type BetterAuthConnectionClient,
} from "./createBetterAuthConnectionAdapter.js";

describe("createBetterAuthConnectionAdapter", () => {
    it("restores and selects concurrent Better Auth sessions", async () => {
        const sessions = [
            {
                session: {
                    id: "session-1",
                    createdAt: new Date(),
                    userId: "user-1",
                    token: "selector-1",
                    expiresAt: new Date(
                        Date.now() + 60_000
                    ),
                    updatedAt: new Date(),
                },
                user: {
                    id: "user-1",
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    email: "ada@example.com",
                    emailVerified: true,
                    name: "Ada Lovelace",
                },
            },
            {
                session: {
                    id: "session-2",
                    createdAt: new Date(),
                    userId: "user-2",
                    token: "selector-2",
                    expiresAt: new Date(
                        Date.now() + 60_000
                    ),
                    updatedAt: new Date(),
                },
                user: {
                    id: "user-2",
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    email: "grace@example.com",
                    emailVerified: true,
                    name: "Grace Hopper",
                },
            },
        ];
        const listDeviceSessions = vi.fn(() =>
            Promise.resolve({
                data: sessions,
                error: null,
            })
        );
        const revoke = vi.fn(() =>
            Promise.resolve({
                data: { status: true },
                error: null,
            })
        );
        const email = vi.fn(
            (_input: {
                email: string;
                password: string;
            }) => {
                void _input;
                return Promise.resolve({
                    data: {
                        user: sessions[0]!.user,
                    },
                    error: null,
                });
            }
        );
        const signIn = Object.assign(
            () => undefined,
            { email }
        );
        let notifySessionChanged = () =>
            Promise.resolve();
        const client = {
            multiSession: {
                listDeviceSessions,
                revoke,
            },
            signIn,
            partyStack: {
                subscribe(listener) {
                    notifySessionChanged =
                        listener;
                    return () => {
                        notifySessionChanged =
                            () =>
                                Promise.resolve();
                    };
                },
            },
        } satisfies BetterAuthConnectionClient;
        const adapter =
            await createBetterAuthConnectionAdapter({
                client,
            })({
                installationId: "better-auth",
                runtime: {} as never,
            });

        const restored =
            await adapter.restoreConnections();

        expect(
            restored.map(
                ({ connection }) =>
                    connection.userId
            )
        ).toEqual(["user-1", "user-2"]);
        const fetch = vi.fn(
            (request: Request) => {
                void request;
                return Promise.resolve(
                    new Response()
                );
            }
        );
        const createWebSocket = vi.fn(() =>
            Promise.resolve({} as WebSocket)
        );
        const first = restored[0];
        if (!first?.session.egress) {
            throw new Error(
                "Expected Better Auth egress."
            );
        }
        const egress = first.session.egress({
            fetch,
            createWebSocket,
        });
        await egress.fetch(
            new Request(
                "https://app.example/ontology"
            )
        );
        const request = fetch.mock.calls[0]?.[0];
        expect(request).toBeInstanceOf(Request);
        expect(
            request?.headers.get(
                "x-party-stack-connection-session"
            )
        ).toBe("session-1");
        expect(request?.credentials).toBe(
            "same-origin"
        );
        await egress.createWebSocket(
            "wss://app.example/ontology",
            "ontology"
        );
        expect(
            createWebSocket
        ).toHaveBeenCalledWith(
            "wss://app.example/ontology",
            [
                "party-stack.session.session-1",
                "ontology",
            ]
        );

        const connected: EstablishedConnection[] =
            [];
        const connect = vi.fn(
            (connection: EstablishedConnection) => {
                connected.push(connection);
                return Promise.resolve();
            }
        );
        const authentication =
            adapter.createAuthenticationClient({
                connect,
                disconnect: () =>
                    Promise.resolve(),
            });
        const result =
            await authentication.signIn.email({
                email: "ada@example.com",
                password: "ada",
            });
        await notifySessionChanged();

        expect(result.data?.user.id).toBe(
            "user-1"
        );
        expect(connect).toHaveBeenCalledTimes(
            2
        );
        expect(
            connected.map(
                ({ connection }) =>
                    connection.userId
            )
        ).toEqual(
            ["user-1", "user-2"]
        );
        await restored[1]!.session.disconnect();
        expect(revoke).toHaveBeenCalledWith({
            sessionToken: "selector-2",
        });
    });
});
