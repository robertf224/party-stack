import { MemoryBlobBytesStore, Runtime } from "@party-stack/runtime";
import { makeTestRuntime } from "@party-stack/runtime/testing";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { makeConnectManager } from "./makeConnectManager.js";
import type { ConnectServiceConfiguration } from "./makeConnectManager.js";

const service: ConnectServiceConfiguration = {
    connector: { service: "example", acquire: ({ handlers }) => Effect.succeed(handlers) },
    instances: [
        {
            id: "stack",
            title: "Stack",
            instanceUrl: "https://example.test",
            OAuthApplications: [
                {
                    id: "app",
                    title: "App",
                    flow: "authorization-code",
                    clientId: "public",
                    redirectUrl: "https://app.test/callback",
                },
            ],
        },
    ],
};
const runtime = makeTestRuntime({
    owner: "device",
    namespace: "manager-test",
    blobBytes: new MemoryBlobBytesStore(),
    encryptionKeyring: Effect.promise(async () => {
        const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
            "encrypt",
            "decrypt",
        ]);
        return { active: Effect.succeed({ id: "key", key }), get: () => Effect.succeed(key) };
    }),
});

test("manager expands its service tree and updates configuration without deleting saved accounts", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const native = yield* runtime;
                const open = (services: readonly ConnectServiceConfiguration[]) =>
                    makeConnectManager({ services, startMaintenance: false }).pipe(
                        Effect.provideService(Runtime, native)
                    );
                const first = yield* open([service]);
                expect(yield* first.store.get("ServiceInstance", "stack")).toMatchObject({
                    service: "example",
                    title: "Stack",
                });
                expect(yield* first.store.get("OAuthApplication", "app")).toMatchObject({
                    serviceInstance: "stack",
                    clientId: "public",
                });
                yield* first.store.put("ExternalSessionConnection", {
                    id: "saved",
                    sessionId: "session",
                    serviceInstance: "stack",
                    userId: "alice",
                    title: "Alice",
                    status: "inactive",
                });
                const second = yield* open([
                    { ...service, instances: [{ ...service.instances![0]!, title: "Renamed" }] },
                ]);
                expect(yield* second.store.get("ServiceInstance", "stack")).toMatchObject({
                    title: "Renamed",
                });
                expect(yield* second.store.get("ExternalSessionConnection", "saved")).toMatchObject({
                    userId: "alice",
                });
                yield* second.maintenance.run;
                expect(yield* second.store.get("ExternalSessionConnection", "saved")).toBeDefined();
            })
        )
    );
});

test("manager rejects ambiguous persisted IDs across service trees", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const native = yield* runtime;
                expect(
                    yield* Effect.result(
                        makeConnectManager({ services: [service, service], startMaintenance: false }).pipe(
                            Effect.provideService(Runtime, native)
                        )
                    )
                ).toMatchObject({ _tag: "Failure", failure: { kind: "InvalidConfiguration" } });
            })
        )
    );
});

test("derived identities survive URL normalization, title changes and application reordering", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const native = yield* runtime;
                const open = (title: string, url: string, clients: string[]) =>
                    makeConnectManager({
                        startMaintenance: false,
                        services: [
                            {
                                connector: {
                                    ...service.connector,
                                    displayName: title,
                                    defaultOAuthScopes: ["read"],
                                },
                                instances: [
                                    {
                                        instanceUrl: url,
                                        OAuthApplications: clients.map((clientId) => ({ clientId })),
                                    },
                                ],
                            },
                        ],
                    }).pipe(Effect.provideService(Runtime, native));
                const first = yield* open("Example", "https://EXAMPLE.test:443/", ["one", "two"]);
                const [instance] = yield* first.store.load("ServiceInstance", {});
                const applications = yield* first.store.load("OAuthApplication", {});
                expect(instance).toMatchObject({ title: "Example", service: "example" });
                expect(applications).toHaveLength(2);
                for (const app of applications)
                    expect(app).toMatchObject({
                        title: "Example",
                        flow: "authorization-code",
                        scopes: ["read"],
                        serviceInstance: instance!.id,
                    });
                const second = yield* open("Renamed", "https://example.test", ["two", "one"]);
                expect(yield* second.store.load("ServiceInstance", {})).toMatchObject([
                    { id: instance!.id, title: "Renamed" },
                ]);
                const updated = yield* second.store.load("OAuthApplication", {});
                expect(updated.map((app) => app.id).sort()).toEqual(applications.map((app) => app.id).sort());
                expect(updated.every((app) => app.title === "Renamed")).toBe(true);
            })
        )
    );
});

test("explicit metadata and empty application scopes override connector defaults", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const manager = yield* makeConnectManager({
                    startMaintenance: false,
                    services: [
                        {
                            connector: {
                                ...service.connector,
                                displayName: "Default",
                                defaultOAuthScopes: ["read"],
                            },
                            instances: [
                                {
                                    id: "custom-instance",
                                    title: "Custom instance",
                                    instanceUrl: "https://example.test",
                                    OAuthApplications: [
                                        {
                                            id: "custom-app",
                                            title: "Custom app",
                                            clientId: "client",
                                            flow: "client-credentials",
                                            scopes: [],
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                }).pipe(Effect.provideService(Runtime, yield* runtime));
                expect(yield* manager.store.get("ServiceInstance", "custom-instance")).toMatchObject({
                    title: "Custom instance",
                });
                expect(yield* manager.store.get("OAuthApplication", "custom-app")).toMatchObject({
                    title: "Custom app",
                    flow: "client-credentials",
                    scopes: [],
                });
            })
        )
    );
});
