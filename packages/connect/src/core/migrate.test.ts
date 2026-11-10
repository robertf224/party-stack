import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o } from "@party-stack/ontology-spec";
import { makeEncryptedValues } from "@party-stack/ontology-storage/encrypted";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect, Schema } from "effect";
import { Temporal } from "temporal-polyfill";
import { expect, test } from "vite-plus/test";
import { connectOntology } from "../spec/index.js";
import { makeConnectPersistence } from "./store.js";

// Fixed pre-service schema: this fixture must remain independent of the new IR.
const legacyConnectOntology = {
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Installation",
            primaryKey: "id",
            displayName: "Installation",
            pluralDisplayName: "Installations",
            properties: [
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
                { name: "providerId", displayName: "Provider", type: o.string({}) },
                { name: "instanceUrl", displayName: "URL", type: o.string({}) },
            ],
        },
        {
            name: "OAuthConnector",
            primaryKey: "id",
            displayName: "Connector",
            pluralDisplayName: "Connectors",
            properties: [
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
                { name: "installation", displayName: "Installation", type: o.string({}) },
                { name: "flow", displayName: "Flow", type: o.string({}) },
                { name: "clientId", displayName: "Client", type: o.string({}) },
            ],
        },
        {
            name: "OAuthConnection",
            primaryKey: "id",
            displayName: "Connection",
            pluralDisplayName: "Connections",
            properties: [
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
                { name: "connector", displayName: "Connector", type: o.string({}) },
                { name: "providerSubjectId", displayName: "User", type: o.string({}) },
                { name: "status", displayName: "Status", type: o.string({}) },
                {
                    name: "accessToken",
                    displayName: "Access token",
                    type: o.optional({ type: o.encrypted({ type: o.string({}) }) }),
                },
                {
                    name: "accessTokenExpiresAt",
                    displayName: "Expires",
                    type: o.optional({ type: o.timestamp({}) }),
                },
            ],
        },
    ],
};

test("opening the pre-scopes service schema preserves saved credentials and authorization attempts", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const previousIR = {
                    ...connectOntology,
                    objectTypes: connectOntology.objectTypes.map((type) =>
                        type.name === "OAuthApplication"
                            ? {
                                  ...type,
                                  properties: type.properties.filter(
                                      (property) => property.name !== "scopes"
                                  ),
                              }
                            : type
                    ),
                };
                const previous = yield* makeOwnedBackend({
                    tables,
                    namespace: JSON.stringify(["saved", "connect", 2]),
                    ir: previousIR,
                    mutators: {},
                });
                const credential = { ciphertext: "party-stack:encrypted:existing-credential" };
                const expiresAt = Temporal.Instant.fromEpochMilliseconds(2_000_000_000_000);
                yield* previous.storage.transaction((tx) =>
                    Effect.gen(function* () {
                        yield* tx.put("ServiceInstance", {
                            id: "foundry",
                            title: "Foundry",
                            service: "foundry",
                            instanceUrl: "https://foundry.test",
                        });
                        yield* tx.put("OAuthApplication", {
                            id: "app",
                            title: "App",
                            serviceInstance: "foundry",
                            flow: "authorization-code",
                            clientId: "client",
                        });
                        yield* tx.put("OAuthConnection", {
                            id: "alice",
                            title: "Alice",
                            application: "app",
                            userId: "alice",
                            status: "active",
                            accessToken: credential,
                            refreshToken: credential,
                        });
                        yield* tx.put("OAuthAuthorizationAttempt", {
                            id: "attempt",
                            application: "app",
                            connectionId: "alice",
                            codeVerifier: credential,
                            redirectUrl: "https://app.test/callback",
                            expiresAt,
                            status: "pending",
                        });
                        yield* tx.put("ApiKeyConnection", {
                            id: "key",
                            title: "Key",
                            serviceInstance: "foundry",
                            userId: "alice",
                            status: "active",
                            apiKey: credential,
                        });
                        yield* tx.put("ExternalSessionConnection", {
                            id: "session",
                            title: "Session",
                            serviceInstance: "foundry",
                            userId: "alice",
                            status: "active",
                            sessionId: "selector",
                        });
                    })
                );
                const upgraded = yield* makeConnectPersistence({ tables, namespace: "saved" });
                expect(yield* upgraded.store.get("OAuthConnection", "alice")).toMatchObject({
                    userId: "alice",
                    accessToken: credential,
                    refreshToken: credential,
                });
                expect(yield* upgraded.store.get("OAuthAuthorizationAttempt", "attempt")).toMatchObject({
                    codeVerifier: credential,
                    connectionId: "alice",
                });
                expect(yield* upgraded.store.get("ApiKeyConnection", "key")).toMatchObject({
                    apiKey: credential,
                });
                expect(yield* upgraded.store.get("ExternalSessionConnection", "session")).toMatchObject({
                    sessionId: "selector",
                });
                const application = (yield* upgraded.store.get("OAuthApplication", "app"))!;
                yield* upgraded.store.put("OAuthApplication", { ...application, scopes: ["read"] });
                const reopened = yield* makeConnectPersistence({ tables, namespace: "saved" });
                expect(yield* reopened.store.get("OAuthApplication", "app")).toMatchObject({
                    scopes: ["read"],
                });
                expect(yield* reopened.store.get("OAuthConnection", "alice")).toMatchObject({
                    accessToken: credential,
                });
            })
        )
    );
});

test("credential migration preserves ciphertext, identity and times and cannot replay over a new credential", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const key = yield* Effect.promise(() =>
                    crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
                );
                const values = makeEncryptedValues("legacy", {
                    active: Effect.succeed({ id: "key", key }),
                    get: () => Effect.succeed(key),
                });
                const token = yield* values.encrypt(Schema.String, "old-access");
                const expiresAt = Temporal.Instant.fromEpochMilliseconds(2_000_000_000_000);
                const legacy = yield* makeOwnedBackend({
                    tables,
                    namespace: "legacy",
                    ir: legacyConnectOntology,
                    mutators: {},
                });
                yield* legacy.storage.transaction((tx) =>
                    Effect.gen(function* () {
                        yield* tx.put("Installation", {
                            id: "foundry",
                            title: "Foundry",
                            providerId: "foundry",
                            instanceUrl: "https://foundry.example",
                        });
                        yield* tx.put("OAuthConnector", {
                            id: "app",
                            title: "App",
                            installation: "foundry",
                            flow: "authorization-code",
                            clientId: "client",
                        });
                        yield* tx.put("OAuthConnection", {
                            id: "alice",
                            title: "Alice",
                            connector: "app",
                            providerSubjectId: "alice",
                            status: "active",
                            accessToken: token,
                            accessTokenExpiresAt: expiresAt,
                        });
                    })
                );
                const { store } = yield* makeConnectPersistence({ tables, namespace: "legacy" });
                const imported = (yield* store.get("OAuthConnection", "alice"))!;
                expect(imported).toMatchObject({
                    id: "alice",
                    application: "app",
                    userId: "alice",
                    accessToken: token,
                });
                expect(imported.accessTokenExpiresAt?.epochMilliseconds).toBe(expiresAt.epochMilliseconds);
                expect(yield* values.decrypt(Schema.String, imported.accessToken!)).toBe("old-access");
                const replacement = yield* values.encrypt(Schema.String, "new-access");
                yield* store.put("OAuthConnection", { ...imported, accessToken: replacement });
                // Simulate retry after a crash between new-state commit and old-state deletion.
                yield* legacy.storage.transaction((tx) =>
                    tx.put("OAuthConnection", {
                        id: "alice",
                        title: "Alice",
                        connector: "app",
                        providerSubjectId: "alice",
                        status: "active",
                        accessToken: token,
                    })
                );
                const reopened = yield* makeConnectPersistence({ tables, namespace: "legacy" });
                expect((yield* reopened.store.get("OAuthConnection", "alice"))?.accessToken).toEqual(
                    replacement
                );
            })
        )
    );
});
