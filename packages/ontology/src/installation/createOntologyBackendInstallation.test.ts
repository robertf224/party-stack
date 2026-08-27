import { createDefaultRuntime, defineRuntime } from "@party-stack/runtime";
import { describe, expect, it, vi } from "vitest";
import type { BackendConnectionAdapter, ConnectionEgressHandlers } from "@party-stack/connections";
import { createOntologyBackendInstallation } from "./createOntologyBackendInstallation.js";
import type { OntologyIR } from "../ir/index.js";

const ir: OntologyIR = {
    types: [],
    objectTypes: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
};

function createTestBackend() {
    return {
        name: "test",
        getCollectionOptions: () => {
            throw new Error("unexpected collection");
        },
        applyAction: () => Promise.reject(new Error("unexpected action")),
        runQueryFunction: () => Promise.reject(new Error("unexpected query")),
    };
}

function createTestConnectionAdapter() {
    const handlers: ConnectionEgressHandlers = {
        fetch: () => Promise.resolve(new Response()),
        createWebSocket: () => Promise.reject(new Error("unexpected websocket")),
    };
    return {
        name: "test",
        createAuthenticationClient: (controller) => ({
            async signIn() {
                const connection = {
                    userId: "user-1",
                    state: {
                        status: "active" as const,
                    },
                };
                await controller.connect({
                    connection,
                    session: {
                        disconnect: () => Promise.resolve(),
                        egress: () => handlers,
                    },
                });
                return connection;
            },
        }),
        restoreConnections: () => Promise.resolve([]),
    } satisfies BackendConnectionAdapter<{
        signIn(): Promise<{
            userId: string;
            state: {
                status: "active";
            };
        }>;
    }>;
}

describe("createOntologyBackendInstallation", () => {
    it("opens isolated LiveOntologies through one stable connection", async () => {
        const cleanupOntology = vi.fn();
        const destroyedNamespaces: string[] = [];
        const runtime = defineRuntime((owner, namespace) => ({
            ...createDefaultRuntime(owner, namespace),
            destroy: () => {
                destroyedNamespaces.push(`${owner}:${namespace}`);
            },
        }));
        const handlers: ConnectionEgressHandlers = {
            fetch: () => Promise.resolve(new Response()),
            createWebSocket: () => Promise.reject(new Error("unexpected websocket")),
        };
        const adapter: BackendConnectionAdapter<{
            signIn(): Promise<{
                userId: string;
                state: { status: "active" };
            }>;
        }> = {
            name: "test",
            createAuthenticationClient: (controller) => ({
                async signIn() {
                    const connection = {
                        userId: "user-1",
                        state: { status: "active" as const },
                    };
                    await controller.connect({
                        connection,
                        session: {
                            disconnect: () => Promise.resolve(),
                            egress: () => handlers,
                        },
                    });
                    return connection;
                },
            }),
            restoreConnections: () => Promise.resolve([]),
        };
        const installation = await createOntologyBackendInstallation({
            installationId: "test-installation",
            connections: () => adapter,
            runtime,
            routes: [
                {
                    matches: () => true,
                    configure: () => ({
                        ir,
                        context: {
                            user: "spoofed",
                        },
                        backend: () => ({
                            name: "test",
                            getCollectionOptions: () => {
                                throw new Error("unexpected collection");
                            },
                            applyAction: () => Promise.reject(new Error("unexpected action")),
                            runQueryFunction: () => Promise.reject(new Error("unexpected query")),
                            cleanup: cleanupOntology,
                        }),
                    }),
                },
            ],
        });

        const connection = await installation.authentication.signIn();
        const first = await installation.openOntology({
            userId: connection.userId,
            ontologyId: "ontology-a",
        });
        const second = await installation.openOntology({
            userId: connection.userId,
            ontologyId: "ontology-b",
        });

        expect(first).not.toBe(second);
        expect(first.context.user).toBe("user-1");

        await installation.disconnect(connection.userId);
        expect(cleanupOntology).toHaveBeenCalledTimes(2);
        expect(installation.connections.get(connection.userId)?.state.status).toBe("inactive");
        await installation.forget(connection.userId);
        expect(installation.connections.get(connection.userId)).toBeUndefined();
        expect(destroyedNamespaces.sort()).toEqual([
            "user-1:test-installation:ontology-a",
            "user-1:test-installation:ontology-b",
        ]);
        await installation.cleanup();
    });

    it("opens metadata through configureMeta", async () => {
        const adapter = createTestConnectionAdapter();
        const cleanupMeta = vi.fn();
        const configureMeta = vi.fn(() => ({
            ir,
            backend: () => ({
                ...createTestBackend(),
                cleanup: cleanupMeta,
            }),
        }));
        const installation = await createOntologyBackendInstallation({
            installationId: "meta-route",
            connections: () => adapter,
            runtime: createDefaultRuntime,
            routes: [
                {
                    matches: (ontologyId) => ontologyId === "ontology",
                    configureMeta,
                },
            ],
        });
        const connection = await installation.authentication.signIn();

        const first = await installation.openMetaOntology({
            userId: connection.userId,
            ontologyId: "ontology",
        });
        const second = await installation.openMetaOntology({
            userId: connection.userId,
            ontologyId: "ontology",
        });

        expect(first).toBe(second);
        expect(first.context.user).toBe("user-1");
        expect(configureMeta).toHaveBeenCalledOnce();
        await installation.closeMetaOntology({
            userId: connection.userId,
            ontologyId: "ontology",
        });
        expect(cleanupMeta).toHaveBeenCalledOnce();
        const reopened = await installation.openMetaOntology({
            userId: connection.userId,
            ontologyId: "ontology",
        });
        expect(reopened).not.toBe(first);
        expect(configureMeta).toHaveBeenCalledTimes(2);
        await installation.disconnect(connection.userId);
        expect(cleanupMeta).toHaveBeenCalledTimes(2);
        await installation.cleanup();
    });

    it("rejects ambiguous dynamic routes", async () => {
        const adapter = createTestConnectionAdapter();
        const installation = await createOntologyBackendInstallation({
            installationId: "ambiguous-routes",
            connections: () => adapter,
            runtime: createDefaultRuntime,
            routes: [
                {
                    matches: () => true,
                    configure: () => ({
                        ir,
                        backend: createTestBackend,
                    }),
                },
                {
                    matches: () => true,
                    configure: () => ({
                        ir,
                        backend: createTestBackend,
                    }),
                },
            ],
        });
        const connection = await installation.authentication.signIn();

        await expect(
            installation.openOntology({
                userId: connection.userId,
                ontologyId: "matched",
            })
        ).rejects.toThrow('Multiple ontology routes matched "matched"');
        await installation.cleanup();
    });

    it("deduplicates concurrent opens and cleanup", async () => {
        const adapter = createTestConnectionAdapter();
        const configure = vi.fn(() => ({
            ir,
            backend: createTestBackend,
        }));
        const installation = await createOntologyBackendInstallation({
            installationId: "concurrent-open",
            connections: () => adapter,
            runtime: createDefaultRuntime,
            routes: [
                {
                    matches: (ontologyId) => ontologyId === "ontology",
                    configure,
                },
            ],
        });
        const connection = await installation.authentication.signIn();

        const [first, second] = await Promise.all([
            installation.openOntology({
                userId: connection.userId,
                ontologyId: "ontology",
            }),
            installation.openOntology({
                userId: connection.userId,
                ontologyId: "ontology",
            }),
        ]);

        expect(first).toBe(second);
        expect(configure).toHaveBeenCalledOnce();
        const firstCleanup = installation.cleanup();
        const secondCleanup = installation.cleanup();
        expect(firstCleanup).toBe(secondCleanup);
        await firstCleanup;
        await expect(
            installation.openOntology({
                userId: connection.userId,
                ontologyId: "ontology",
            })
        ).rejects.toThrow('Backend installation "concurrent-open" is closed.');
    });
});
