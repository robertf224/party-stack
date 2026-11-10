import { MemoryBlobBytesStore, Runtime } from "@party-stack/runtime";
import { makeTestRuntime } from "@party-stack/runtime/testing";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { acquireConfiguredConnection } from "./acquireConfiguredConnection.js";
import { makeAuthenticationClient } from "./authentication.js";
import { makeConnectManager } from "./makeConnectManager.js";
import type { ServiceConnector } from "./ServiceConnector.js";
import type { BrowserAuthentication } from "@party-stack/runtime";

const setup = Effect.fnUntraced(function* (acquire?: ServiceConnector["acquire"]) {
    const key = yield* Effect.promise(() =>
        crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
    );
    const runtime = yield* makeTestRuntime({
        owner: "connect",
        namespace: "bootstrap",
        blobBytes: new MemoryBlobBytesStore(),
        encryptionKeyring: Effect.succeed({
            active: Effect.succeed({ id: "key", key }),
            get: () => Effect.succeed(key),
        }),
    });
    const exchange = vi.fn(() =>
        Effect.succeed({ accessToken: "private-access", refreshToken: "private-refresh", userId: "alice" })
    );
    const refresh = vi.fn(() => Effect.succeed({ accessToken: "refreshed-access", userId: "alice" }));
    const service: ServiceConnector = {
        service: "test",
        oauth: () =>
            Effect.succeed({
                authorizationUrl: ({ state }) =>
                    Effect.succeed(`https://service.test/authorize?state=${state}`),
                exchange,
                refresh,
                clientCredentials: Effect.die("unused"),
            }),
        apiKey: () => Effect.succeed({ userId: "alice" }),
        externalSession: () => Effect.succeed({ userId: "bob" }),
        acquire: acquire ?? (({ handlers }) => Effect.succeed(handlers)),
    };
    const manager = yield* makeConnectManager({
        services: [
            {
                connector: service,
                instances: [
                    {
                        id: "stack",
                        title: "Stack",
                        instanceUrl: "https://service.test",
                        OAuthApplications: [
                            {
                                id: "app",
                                title: "App",
                                clientId: "public",
                                redirectUrl: "https://app.test/callback",
                                flow: "authorization-code",
                            },
                        ],
                    },
                ],
            },
        ],
        startMaintenance: false,
    }).pipe(Effect.provideService(Runtime, runtime));
    const open = vi.fn((url: string) =>
        Effect.succeed({
            callbackUrl: `https://app.test/callback?state=${new URL(url).searchParams.get("state")}&code=private-code`,
        })
    );
    const start = vi.fn(() => Effect.succeed({ open }));
    const browser: BrowserAuthentication = { start };
    const client = makeAuthenticationClient({ backend: manager.backend, browserAuthentication: browser });
    return { manager, client, browser, start, exchange, refresh };
});

const oauth = { applicationId: "app", redirectUrl: "https://app.test/callback" };

test("authentication account references work across sign-in, inventory, sign-out and journaled forget", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* setup();
                const signedIn = yield* f.client.oauth(oauth).signIn();
                expect(signedIn).toMatchObject({ kind: "oauth", id: expect.any(String) });
                const [attempt] = yield* f.manager.store.load("OAuthAuthorizationAttempt", {});
                expect(
                    yield* f.client
                        .oauth(oauth)
                        .complete(`https://app.test/callback?state=${attempt!.id}&code=private-code`)
                ).toMatchObject({ kind: "oauth", id: signedIn.id });
                const accounts = [
                    signedIn,
                    yield* f.client.connectApiKey("stack", "private-key"),
                    yield* f.client.attachExternalSession("stack", "private-session"),
                ];
                expect(accounts.map((account) => account.kind)).toEqual([
                    "oauth",
                    "api-key",
                    "external-session",
                ]);
                const inventory = yield* f.client.connections;
                expect(inventory.map((account) => account.kind).sort()).toEqual([
                    "api-key",
                    "external-session",
                    "oauth",
                ]);
                expect(inventory.every((account) => !Object.hasOwn(account, "objectType"))).toBe(true);
                for (const account of accounts) yield* f.client.signOut(account);
                expect((yield* f.client.connections).map((account) => account.status)).toEqual([
                    "inactive",
                    "inactive",
                    "inactive",
                ]);
                const before = yield* f.manager.backend.changes!.pull({});
                for (const account of inventory) {
                    yield* f.client.forget(account);
                }
                expect(yield* f.client.connections).toEqual([]);
                const deleted = (yield* f.manager.backend.changes!.pull({ cursor: before.cursor })).commits
                    .flatMap((commit) => commit.changes)
                    .filter((change) => change.kind === "delete");
                expect(deleted.map((change) => change.objectType)).toEqual(
                    expect.arrayContaining([
                        "OAuthConnection",
                        "ApiKeyConnection",
                        "ExternalSessionConnection",
                    ])
                );
            })
        )
    );
});

test("bootstrap and native client use the same saved inventory, reuse accounts, and expose no secrets", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* setup();
                const first = yield* acquireConfiguredConnection({
                    manager: f.manager,
                    serviceInstanceId: "stack",
                    oauth,
                    browserAuthentication: f.browser,
                });
                const second = yield* acquireConfiguredConnection({
                    manager: f.manager,
                    serviceInstanceId: "stack",
                    oauth,
                });
                expect(second).toBe(first);
                expect(f.start).toHaveBeenCalledOnce();
                expect(f.exchange).toHaveBeenCalledOnce();
                const saved = yield* f.client.connections;
                expect(saved).toEqual([
                    {
                        kind: "oauth",
                        id: first.connection.id,
                        userId: "alice",
                        title: expect.any(String),
                        status: "active",
                    },
                ]);
                expect(JSON.stringify(saved)).not.toMatch(/private-|ciphertext|accessToken|refreshToken/);
                yield* f.client.signOut({ kind: "oauth", id: first.connection.id });
                expect(yield* f.manager.store.get("OAuthConnection", first.connection.id)).toMatchObject({
                    status: "inactive",
                    accessToken: undefined,
                });
                const resumed = yield* acquireConfiguredConnection({
                    manager: f.manager,
                    serviceInstanceId: "stack",
                    oauth,
                    userId: "alice",
                    browserAuthentication: f.browser,
                });
                expect(resumed.connection).toEqual(first.connection);
                expect(yield* f.client.connections).toHaveLength(1);
            })
        )
    );
});

test("bootstrap rejects ambiguous accounts, allows explicit selection, and checks the service instance", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* setup();
                for (const userId of ["alice", "bob"])
                    yield* f.manager.store.put("OAuthConnection", {
                        id: userId,
                        application: "app",
                        title: userId,
                        userId,
                        status: "active",
                    });
                expect(
                    yield* Effect.result(
                        acquireConfiguredConnection({ manager: f.manager, serviceInstanceId: "stack", oauth })
                    )
                ).toMatchObject({
                    _tag: "Failure",
                    failure: {
                        kind: "InvalidConfiguration",
                        message: expect.stringContaining("Multiple accounts"),
                    },
                });
                expect(
                    (yield* acquireConfiguredConnection({
                        manager: f.manager,
                        serviceInstanceId: "stack",
                        oauth,
                        userId: "bob",
                    })).userId
                ).toBe("bob");
                expect(
                    yield* Effect.result(
                        acquireConfiguredConnection({
                            manager: f.manager,
                            serviceInstanceId: "other",
                            oauth,
                            userId: "bob",
                        })
                    )
                ).toMatchObject({
                    _tag: "Failure",
                    failure: {
                        kind: "InvalidConfiguration",
                        message: expect.stringContaining("different service"),
                    },
                });
                expect(f.start).not.toHaveBeenCalled();
            })
        )
    );
});

test("API key and external-session commands use verified identities in the same manager", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* setup();
                const key = yield* acquireConfiguredConnection({
                    manager: f.manager,
                    serviceInstanceId: "stack",
                    apiKey: "private-key",
                    userId: "alice",
                });
                expect(key.userId).toBe("alice");
                expect(f.start).not.toHaveBeenCalled();
                expect(
                    yield* Effect.result(
                        acquireConfiguredConnection({
                            manager: f.manager,
                            serviceInstanceId: "stack",
                            apiKey: "private-key",
                            userId: "bob",
                        })
                    )
                ).toMatchObject({
                    _tag: "Failure",
                    failure: {
                        kind: "InvalidConfiguration",
                        message: expect.stringContaining('connection.userId is "bob"'),
                    },
                });
                const external = yield* f.client.attachExternalSession("stack", "private-session");
                expect((yield* f.client.connections).map((row) => row.kind).sort()).toEqual([
                    "api-key",
                    "external-session",
                ]);
                yield* f.client.signOut(external);
                yield* f.client.signOut({ kind: "api-key", id: key.connection.id });
                expect((yield* f.client.connections).every((row) => row.status === "inactive")).toBe(true);
            })
        )
    );
});

test("rejected credentials refresh once and a stale response cannot refresh a newer login", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let refreshCredential: ((token: string) => Effect.Effect<string, unknown>) | undefined;
                const f = yield* setup(({ handlers, refreshCredential: refresh }) => {
                    refreshCredential = refresh;
                    return Effect.succeed(handlers);
                });
                const access = yield* acquireConfiguredConnection({
                    manager: f.manager,
                    serviceInstanceId: "stack",
                    oauth,
                    browserAuthentication: f.browser,
                });
                const started = yield* Deferred.make<void>();
                const reply = yield* Deferred.make<void>();
                f.refresh.mockImplementation(() =>
                    Effect.gen(function* () {
                        yield* Deferred.succeed(started, undefined);
                        yield* Deferred.await(reply);
                        return { accessToken: "refreshed-access", userId: "alice" };
                    })
                );
                const one = yield* refreshCredential!("private-access").pipe(Effect.forkScoped);
                yield* Deferred.await(started);
                const two = yield* refreshCredential!("private-access").pipe(Effect.forkScoped);
                yield* Deferred.succeed(reply, undefined);
                expect(yield* Fiber.join(one)).toBe("refreshed-access");
                expect(yield* Fiber.join(two)).toBe("refreshed-access");
                expect(f.refresh).toHaveBeenCalledOnce();
                const current = (yield* f.manager.store.get("OAuthConnection", access.connection.id))!;
                yield* f.manager.store.put("OAuthConnection", {
                    ...current,
                    accessToken: yield* f.manager.values.encrypt(Schema.String, "new-login"),
                });
                expect(yield* refreshCredential!("refreshed-access")).toBe("new-login");
                expect(f.refresh).toHaveBeenCalledOnce();
            })
        )
    );
});
