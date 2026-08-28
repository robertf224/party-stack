import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeAdapterProvider } from "@party-stack/runtime";

const mocks = vi.hoisted(() => ({
    createFoundryBackendInstallation: vi.fn(),
    createFoundryOntologyRoute: vi.fn(() => "meta-route"),
}));

vi.mock("../installation/createFoundryBackendInstallation.js", () => mocks);

import { createFoundryOntologyPullSource } from "./index.js";

function installation(
    connections: Array<{
        userId: string;
        state: { status: "active" };
    }> = []
) {
    const oauth = vi.fn(() =>
        Promise.resolve({
            userId: "oauth-user",
            state: { status: "active" as const },
        })
    );
    const apiToken = vi.fn(() =>
        Promise.resolve({
            userId: "token-user",
            state: { status: "active" as const },
        })
    );
    return {
        connections: {
            values: () => connections.values(),
        },
        authentication: {
            signIn: {
                oauth,
                apiToken,
            },
        },
        oauth,
        apiToken,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("Foundry connection-backed pull", () => {
    it("creates a metadata-capable backend installation", async () => {
        const backendInstallation = installation();
        mocks.createFoundryBackendInstallation.mockResolvedValue(backendInstallation);
        const runtime = vi.fn() as unknown as RuntimeAdapterProvider;
        const source = createFoundryOntologyPullSource({
            baseUrl: "https://foundry.example",
            ontologyRid: "ri.ontology.main",
            connection: {
                oauth: {
                    clientId: "client",
                    redirectUrl: "http://127.0.0.1:9876/callback",
                },
            },
        });

        await source.createInstallation({ runtime });

        expect(mocks.createFoundryOntologyRoute).toHaveBeenCalledWith({
            ontologyId: "ri.ontology.main",
        });
        expect(mocks.createFoundryBackendInstallation).toHaveBeenCalledWith({
            installationId: "foundry-pull:https://foundry.example:ri.ontology.main",
            baseUrl: "https://foundry.example",
            runtime,
            connections: {
                token: undefined,
                oauth: {
                    clientId: "client",
                    redirectUrl: "http://127.0.0.1:9876/callback",
                    scopes: ["api:use-ontologies-read", "offline_access"],
                },
            },
            routes: ["meta-route"],
        });
    });

    it("restores the sole active connection", async () => {
        const backendInstallation = installation([
            {
                userId: "restored-user",
                state: { status: "active" },
            },
        ]);
        const source = createFoundryOntologyPullSource({
            baseUrl: "https://foundry.example",
            ontologyRid: "ri.ontology.main",
            connection: {
                oauth: {
                    clientId: "client",
                    redirectUrl: "http://127.0.0.1:9876/callback",
                },
            },
        });

        await expect(source.resolveConnection(backendInstallation as never)).resolves.toMatchObject({
            userId: "restored-user",
        });
        expect(backendInstallation.oauth).not.toHaveBeenCalled();
    });

    it("starts OAuth when no session can be restored", async () => {
        const backendInstallation = installation();
        const source = createFoundryOntologyPullSource({
            baseUrl: "https://foundry.example",
            ontologyRid: "ri.ontology.main",
            connection: {
                oauth: {
                    clientId: "client",
                    redirectUrl: "http://127.0.0.1:9876/callback",
                },
            },
        });

        await expect(source.resolveConnection(backendInstallation as never)).resolves.toMatchObject({
            userId: "oauth-user",
        });
        expect(backendInstallation.oauth).toHaveBeenCalledOnce();
    });

    it("uses the API token authentication path", async () => {
        const backendInstallation = installation();
        const source = createFoundryOntologyPullSource({
            baseUrl: "https://foundry.example",
            ontologyRid: "ri.ontology.main",
            connection: {
                token: "token",
            },
        });

        await expect(source.resolveConnection(backendInstallation as never)).resolves.toMatchObject({
            userId: "token-user",
        });
        expect(backendInstallation.apiToken).toHaveBeenCalledOnce();
        expect(backendInstallation.oauth).not.toHaveBeenCalled();
    });

    it("rejects ambiguous restored users", async () => {
        const backendInstallation = installation([
            {
                userId: "one",
                state: { status: "active" },
            },
            {
                userId: "two",
                state: { status: "active" },
            },
        ]);
        const source = createFoundryOntologyPullSource({
            baseUrl: "https://foundry.example",
            ontologyRid: "ri.ontology.main",
            connection: {
                oauth: {
                    clientId: "client",
                    redirectUrl: "http://127.0.0.1:9876/callback",
                },
            },
        });

        await expect(source.resolveConnection(backendInstallation as never)).rejects.toThrow(
            "Multiple Foundry users are signed in"
        );
    });
});
