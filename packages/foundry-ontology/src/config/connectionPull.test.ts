import { Runtimes, MemoryRuntime } from "@party-stack/runtime";
import { Effect } from "effect";
import { beforeEach, expect, test, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({ manager: vi.fn(), acquire: vi.fn(), metadata: vi.fn() }));
vi.mock("@party-stack/connect", async (original) => ({
    ...(await original<typeof import("@party-stack/connect")>()),
    makeConnectManager: mocks.manager,
    acquireConfiguredConnection: mocks.acquire,
}));
vi.mock("../backend.js", () => ({ makeFoundryMetadataBackend: mocks.metadata }));
import { makeFoundryPullBackend } from "./index.js";

const manager = { backend: "current-connect-backend" };
const egress = { fetch: vi.fn(), createWebSocket: vi.fn() };
beforeEach(() => {
    vi.clearAllMocks();
    mocks.manager.mockReturnValue(Effect.succeed(manager));
    mocks.acquire.mockReturnValue(Effect.succeed({ egress }));
    mocks.metadata.mockReturnValue(Effect.succeed({ name: "metadata" }));
});
const open = (connection: Parameters<typeof makeFoundryPullBackend>[0]["connection"]) =>
    Effect.runPromise(
        Effect.scoped(
            makeFoundryPullBackend({
                baseUrl: "https://foundry.example",
                ontologyRid: "ri.ontology.main",
                connection,
            })
        ).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
    );

test("pull configures the current Connect manager and opens metadata with its acquired egress", async () => {
    const oauth = { clientId: "client", redirectUrl: "http://localhost:9876/callback", scopes: ["api:read"] };
    expect(await open({ oauth, userId: "alice" })).toMatchObject({ name: "metadata" });
    expect(mocks.manager).toHaveBeenCalledWith({
        services: [
            {
                connector: expect.objectContaining({ service: "foundry" }),
                instances: [
                    expect.objectContaining({
                        id: "https://foundry.example",
                        OAuthApplications: [
                            expect.objectContaining({
                                id: "client",
                                clientId: "client",
                                scopes: oauth.scopes,
                                redirectUrl: oauth.redirectUrl,
                            }),
                        ],
                    }),
                ],
            },
        ],
    });
    expect(mocks.acquire).toHaveBeenCalledWith(
        expect.objectContaining({
            manager,
            serviceInstanceId: "https://foundry.example",
            userId: "alice",
            oauth: { applicationId: "client", redirectUrl: oauth.redirectUrl },
        })
    );
    expect(mocks.metadata).toHaveBeenCalledWith({
        baseUrl: "https://foundry.example",
        ontologyId: "ri.ontology.main",
        egress,
    });
});

test("token bootstrap uses the same acquisition path without an OAuth application", async () => {
    await open({ token: "private-key" });
    expect(mocks.acquire).toHaveBeenCalledWith(
        expect.objectContaining({ manager, apiKey: "private-key", oauth: undefined })
    );
    expect(mocks.manager.mock.calls[0]![0].services[0].instances[0].OAuthApplications).toEqual([]);
});
