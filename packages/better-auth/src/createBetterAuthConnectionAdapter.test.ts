import { Runtime, type RuntimeAdapter } from "@party-stack/runtime";
import { closeRuntimeFixture } from "@party-stack/runtime/testing";
import { runtimeFixtureContext, memoryRuntimeFixture } from "@party-stack/runtime/testing";
import { Effect, Exit, Scope } from "effect";
import type { BackendConnectionAdapterProvider } from "@party-stack/connect";
const releaseAdapters: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const close of releaseAdapters.splice(0)) await close();
});
async function openAdapter<A extends object>(
    provider: BackendConnectionAdapterProvider<A>,
    options: { installationId: string; runtime?: RuntimeAdapter }
) {
    const runtime = options.runtime ?? memoryRuntimeFixture("installation", crypto.randomUUID());
    const managed = runtimeFixtureContext(runtime).runtime;
    const owner = await managed.runPromise(Effect.flatMap(Runtime, (service) => Scope.fork(service.scope)));
    releaseAdapters.push(async () => {
        await Effect.runPromise(Scope.close(owner, Exit.void));
        await closeRuntimeFixture(runtime);
    });
    const adapter = await managed.runPromise(
        Scope.provide(provider({ ...options, runtime, scope: owner }), owner)
    );
    await Effect.runPromise(Scope.addFinalizer(owner, adapter.cleanup?.() ?? Effect.void));
    return adapter;
}
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
    createBetterAuthConnectionAdapter,
    type BetterAuthConnectionClient,
} from "./createBetterAuthConnectionAdapter.js";
import type { EstablishedConnection } from "@party-stack/connect";

describe("createBetterAuthConnectionAdapter", () => {
    it("restores and selects concurrent Better Auth sessions", async () => {
        const sessions = [
            {
                session: {
                    id: "session-1",
                    createdAt: new Date(),
                    userId: "user-1",
                    token: "selector-1",
                    expiresAt: new Date(Date.now() + 60_000),
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
                    expiresAt: new Date(Date.now() + 60_000),
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
        const email = vi.fn((_input: { email: string; password: string }) => {
            void _input;
            return Promise.resolve({
                data: {
                    user: sessions[0]!.user,
                },
                error: null,
            });
        });
        const signIn = Object.assign(() => undefined, { email });
        let notifySessionChanged = () => Promise.resolve();
        const client = {
            multiSession: {
                listDeviceSessions,
                revoke,
            },
            signIn,
            partyStack: {
                subscribe(listener) {
                    notifySessionChanged = listener;
                    return () => {
                        notifySessionChanged = () => Promise.resolve();
                    };
                },
            },
        } satisfies BetterAuthConnectionClient;
        const adapter = await openAdapter(
            createBetterAuthConnectionAdapter({
                client,
            }),
            {
                installationId: "better-auth",
            }
        );

        const restored = await Effect.runPromise(adapter.restoreConnections());

        expect(restored.map(({ connection }) => connection.userId)).toEqual(["user-1", "user-2"]);
        const fetch = vi.fn((request: Request) => {
            void request;
            return Promise.resolve(new Response());
        });
        const createWebSocket = vi.fn(() => Promise.resolve({} as WebSocket));
        const first = restored[0];
        if (!first?.session.egress) {
            throw new Error("Expected Better Auth egress.");
        }
        const egress = first.session.egress({
            fetch,
            createWebSocket,
        });
        await egress.fetch(new Request("https://app.example/ontology"));
        const request = fetch.mock.calls[0]?.[0];
        expect(request).toBeInstanceOf(Request);
        expect(request?.headers.get("x-party-stack-connection-session")).toBe("session-1");
        expect(request?.credentials).toBe("same-origin");
        await egress.createWebSocket("wss://app.example/ontology", "ontology");
        expect(createWebSocket).toHaveBeenCalledWith("wss://app.example/ontology", [
            "party-stack.session.session-1",
            "ontology",
        ]);

        const connected: EstablishedConnection[] = [];
        const connect = vi.fn((connection: EstablishedConnection) => {
            connected.push(connection);
            return Effect.void;
        });
        const authentication = adapter.createAuthenticationClient({
            connect,
            disconnect: () => Effect.void,
        });
        const result = await authentication.signIn.email({
            email: "ada@example.com",
            password: "ada",
        });
        await notifySessionChanged();

        expect(result.data?.user.id).toBe("user-1");
        expect(connect).toHaveBeenCalledTimes(2);
        expect(connected.map(({ connection }) => connection.userId)).toEqual(["user-1", "user-2"]);
        await Effect.runPromise(restored[1]!.session.disconnect());
        expect(revoke).toHaveBeenCalledWith({
            sessionToken: "selector-2",
        });
    });
});

it("restores offline session selectors across adapter recreation without storing bearer tokens", async () => {
    const Memory = await import("@party-stack/ontology-storage/memory/tables");
    const { Table } = await import("@party-stack/ontology-storage/tables");
    const { memoryRuntimeFixture, defineRuntimeFixture } = await import("@party-stack/runtime/testing");
    const tables = await Effect.runPromise(Memory.make());
    let online = true;
    const base = memoryRuntimeFixture("installation", "offline-better-auth");
    const runtime = defineRuntimeFixture(() => ({
        ...base,
        tables: Effect.succeed(tables),
        connectivity: {
            get isConnected() {
                return online;
            },
            subscribe: () => () => undefined,
        },
    }))("installation", "offline-better-auth");
    const selected = {
        session: {
            id: "public-selector",
            token: "private-bearer-token",
            userId: "user",
            expiresAt: new Date(Date.now() + 60000),
            createdAt: new Date(),
            updatedAt: new Date(),
        },
        user: {
            id: "user",
            name: "Local fixture",
            email: "fixture@example.test",
            emailVerified: true,
            createdAt: new Date(),
            updatedAt: new Date(),
        },
    };
    const listDeviceSessions = vi.fn(async () => ({ data: [selected], error: null }));
    const client = {
        signIn: {},
        multiSession: { listDeviceSessions, revoke: vi.fn(async () => ({ data: {} })) },
        partyStack: { subscribe: () => () => undefined },
    } satisfies BetterAuthConnectionClient;
    const provider = createBetterAuthConnectionAdapter({ client });
    try {
        const first = await openAdapter(provider, { installationId: "test", runtime });
        expect(
            (await Effect.runPromise(first.restoreConnections())).map((value) => value.connection.userId)
        ).toEqual(["user"]);
        await Effect.runPromise(first.cleanup?.() ?? Effect.void);
        const rows = await Effect.runPromise(
            tables.loadSubset(
                Table.make({ name: JSON.stringify(["better-auth", "test", "session-selectors"]) })
            )
        );
        expect(JSON.stringify(rows)).toContain("public-selector");
        expect(JSON.stringify(rows)).not.toContain("private-bearer-token");
        expect(JSON.stringify(rows)).not.toContain("fixture@example.test");
        online = false;
        listDeviceSessions.mockClear();
        const restored = await openAdapter(provider, { installationId: "test", runtime });
        const connections = await Effect.runPromise(restored.restoreConnections());
        expect(connections.map((value) => value.connection.userId)).toEqual(["user"]);
        expect(listDeviceSessions).not.toHaveBeenCalled();
        const fetch = vi.fn(async (_request: Request) => new Response());
        const egress = connections[0]!.session.egress!({
            fetch,
            createWebSocket: async () => ({}) as WebSocket,
        });
        await egress.fetch(new Request("https://app.example.test/data"));
        expect(fetch.mock.calls[0]?.[0].headers.get("x-party-stack-connection-session")).toBe(
            "public-selector"
        );
        await Effect.runPromise(restored.cleanup?.() ?? Effect.void);
    } finally {
        await closeRuntimeFixture(runtime);
    }
});
