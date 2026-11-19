import { BrowserAuthenticationError, MemoryBlobBytesStore, Runtime } from "@party-stack/runtime";
import { makeTestRuntime } from "@party-stack/runtime/testing";
import { Deferred, Effect, Fiber } from "effect";
import { Temporal } from "temporal-polyfill";
import { expect, test, vi } from "vite-plus/test";
import { acquireConfiguredConnection } from "./acquireConfiguredConnection.js";
import { makeAuthenticationClient } from "./authentication.js";
import { connectError } from "./core/errors.js";
import { makeConnectManager } from "./makeConnectManager.js";
import { withHttpAuthenticationErrors } from "./withHttpAuthenticationErrors.js";
import type { ConnectError } from "./core/errors.js";
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
    const refresh = vi.fn((): Effect.Effect<{ accessToken: string; userId: string }, ConnectError> =>
        Effect.succeed({ accessToken: "refreshed-access", userId: "alice" })
    );
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
    const start = vi.fn((): ReturnType<BrowserAuthentication["start"]> => Effect.succeed({ open }));
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

test("a blocked sign-in popup keeps its reason so the app can redirect instead", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* setup();
                f.start.mockImplementation(() =>
                    Effect.fail(
                        new BrowserAuthenticationError({
                            reason: "PopupBlocked",
                            message: "The authentication popup was blocked.",
                        })
                    )
                );
                const result = yield* Effect.result(f.client.oauth(oauth).signIn());
                expect(result).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "Unavailable", cause: { reason: "PopupBlocked" } },
                });
            })
        )
    );
});

test("rejected credentials renew once, retry body-less requests, and never renew a newer login", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const sent: string[] = [];
                const f = yield* setup(({ credential }) =>
                    Effect.succeed(
                        withHttpAuthenticationErrors({
                            fetch: (request) =>
                                Effect.gen(function* () {
                                    const token = yield* credential;
                                    sent.push(`${request.method} ${token}`);
                                    return new Response(null, {
                                        status: token === "private-access" ? 401 : 200,
                                    });
                                }),
                            createWebSocket: () => Effect.die("unused"),
                        })
                    )
                );
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
                const version = access.authentication.credentialVersion;
                const one = yield* access.egress.fetch("https://service.test/one").pipe(Effect.forkScoped);
                yield* Deferred.await(started);
                const two = yield* access.egress.fetch("https://service.test/two").pipe(Effect.forkScoped);
                yield* Deferred.succeed(reply, undefined);
                // Both rejections share one renewal, and both requests are retried.
                expect((yield* Fiber.join(one)).status).toBe(200);
                expect((yield* Fiber.join(two)).status).toBe(200);
                expect(f.refresh).toHaveBeenCalledOnce();
                expect(sent.filter((line) => line === "GET refreshed-access")).toHaveLength(2);
                expect(access.authentication.state.status).toBe("active");
                expect(access.authentication.credentialVersion).toBeGreaterThan(version);
                // A rejection of the replaced credential does not renew the newer one.
                yield* access.authentication.refresh(version);
                expect(f.refresh).toHaveBeenCalledOnce();
            })
        )
    );
});

// Requests 2..n see the stale token and queue for renewal while the first one's
// provider refresh is in flight; the authority would fail their own refreshes with Conflict.
const earlyRefreshRace = Effect.fnUntraced(function* (
    requests: number,
    refreshed: Effect.Effect<
        { accessToken: string; accessTokenExpiresAt?: Temporal.Instant; userId: string },
        ConnectError
    >
) {
    const sent: string[] = [];
    const f = yield* setup(({ credential }) =>
        Effect.succeed({
            fetch: (request) =>
                Effect.gen(function* () {
                    sent.push(`${new URL(request.url).pathname} ${yield* credential}`);
                    return new Response();
                }),
            createWebSocket: () => Effect.die("unused"),
        })
    );
    // Inside the renewal window, so the next request refreshes before sending.
    f.exchange.mockImplementation(() =>
        Effect.succeed({
            accessToken: "private-access",
            accessTokenExpiresAt: Temporal.Now.instant().add({ seconds: 1 }),
            refreshToken: "private-refresh",
            userId: "alice",
        })
    );
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
            return yield* refreshed;
        })
    );
    const version = access.authentication.credentialVersion;
    const fetch = (index: number) =>
        access.egress.fetch(`https://service.test/${index}`).pipe(Effect.result, Effect.forkScoped);
    const first = yield* fetch(1);
    yield* Deferred.await(started);
    const rest = yield* Effect.forEach(
        Array.from({ length: requests - 1 }, (_, i) => i + 2),
        fetch
    );
    yield* Effect.sleep(50);
    yield* Deferred.succeed(reply, undefined);
    const results = yield* Effect.forEach([first, ...rest], Fiber.join);
    return { f, access, version, sent, results };
});

test("concurrent requests with an expiring credential share one early refresh", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { f, access, version, sent, results } = yield* earlyRefreshRace(
                    3,
                    Effect.succeed({ accessToken: "refreshed-access", userId: "alice" })
                );
                expect(results.map((result) => result._tag)).toEqual(["Success", "Success", "Success"]);
                expect(f.refresh).toHaveBeenCalledOnce();
                expect([...sent].sort()).toEqual([
                    "/1 refreshed-access",
                    "/2 refreshed-access",
                    "/3 refreshed-access",
                ]);
                expect(access.authentication.credentialVersion).toBeGreaterThan(version);
                // A late rejection of the replaced credential does not renew the new one.
                yield* access.authentication.refresh(version);
                expect(f.refresh).toHaveBeenCalledOnce();
            })
        )
    );
});

test("a refreshed token that is also short-lived is not refreshed again by queued requests", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { f, sent, results } = yield* earlyRefreshRace(
                    3,
                    Effect.sync(() => ({
                        accessToken: "short-access",
                        accessTokenExpiresAt: Temporal.Now.instant().add({ seconds: 30 }),
                        userId: "alice",
                    }))
                );
                expect(results.map((result) => result._tag)).toEqual(["Success", "Success", "Success"]);
                expect(f.refresh).toHaveBeenCalledOnce();
                expect([...sent].sort()).toEqual(["/1 short-access", "/2 short-access", "/3 short-access"]);
            })
        )
    );
});

test("requests queued behind a failed early refresh share its failure", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { f, access, sent, results } = yield* earlyRefreshRace(
                    3,
                    Effect.fail(connectError("Provider", "Token endpoint unavailable.", true))
                );
                for (const result of results)
                    expect(result).toMatchObject({
                        _tag: "Failure",
                        failure: { kind: "Unavailable", retryable: true },
                    });
                expect(f.refresh).toHaveBeenCalledOnce();
                expect(sent).toEqual([]);
                expect(access.authentication.state.status).toBe("active");
            })
        )
    );
});

test("a rejected request with a body is renewed and left to its caller to retry", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let calls = 0;
                const f = yield* setup(({ credential }) =>
                    Effect.succeed(
                        withHttpAuthenticationErrors({
                            fetch: () =>
                                Effect.gen(function* () {
                                    calls++;
                                    const token = yield* credential;
                                    return new Response(null, {
                                        status: token === "private-access" ? 401 : 200,
                                    });
                                }),
                            createWebSocket: () => Effect.die("unused"),
                        })
                    )
                );
                const access = yield* acquireConfiguredConnection({
                    manager: f.manager,
                    serviceInstanceId: "stack",
                    oauth,
                    browserAuthentication: f.browser,
                });
                const post = () =>
                    access.egress.fetch("https://service.test/data", { method: "POST", body: "payload" });
                expect(yield* Effect.result(post())).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "Unavailable", retryable: true, actionOutcome: "not-committed" },
                });
                expect([calls, f.refresh.mock.calls.length]).toEqual([1, 1]);
                expect(access.authentication.state.status).toBe("active");
                expect((yield* post()).status).toBe(200);
            })
        )
    );
});

test("a credential that cannot be renewed moves the connection to needs-auth", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* setup(({ credential }) =>
                    Effect.succeed(
                        withHttpAuthenticationErrors({
                            fetch: () =>
                                Effect.flatMap(credential, () =>
                                    Effect.succeed(new Response(null, { status: 401 }))
                                ),
                            createWebSocket: () => Effect.die("unused"),
                        })
                    )
                );
                const access = yield* acquireConfiguredConnection({
                    manager: f.manager,
                    serviceInstanceId: "stack",
                    oauth,
                    browserAuthentication: f.browser,
                });
                f.refresh.mockImplementation(() =>
                    Effect.fail(connectError("NeedsAuthentication", "Refresh token revoked."))
                );
                const result = yield* Effect.result(access.egress.fetch("https://service.test/one"));
                expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "Unauthenticated" } });
                expect(f.refresh).toHaveBeenCalledOnce();
                expect(access.authentication.state.status).toBe("needs-auth");
            })
        )
    );
});

// Oracle for credential renewal. Random schedules of concurrent requests, token
// revocations at the service, and provider refresh outcomes must agree with a
// model: one renewal per rejected credential, body-less requests retried after a
// successful renewal, bodies never sent twice, and needs-auth exactly when the
// refresh token itself is rejected.
type RefreshOutcome = "ok" | "unavailable" | "revoked";
const random = (seed: number) => () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
};
test("credential renewal agrees with the renewal oracle across random schedules", async () => {
    for (let scenario = 0; scenario < 40; scenario++) {
        const next = random(scenario + 1);
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    let issued = 0;
                    // The service accepts tokens issued at or after this index.
                    let validFrom = 0;
                    const tokenIndex = (token: string) =>
                        token === "private-access" ? 0 : Number(token.slice(1));
                    const received: string[] = [];
                    let outcome: RefreshOutcome = "ok";
                    const f = yield* setup(({ credential }) =>
                        Effect.succeed(
                            withHttpAuthenticationErrors({
                                fetch: (request) =>
                                    Effect.gen(function* () {
                                        const token = yield* credential;
                                        received.push(`${request.method} ${new URL(request.url).pathname}`);
                                        return new Response(null, {
                                            status: tokenIndex(token) >= validFrom ? 200 : 401,
                                        });
                                    }),
                                createWebSocket: () => Effect.die("unused"),
                            })
                        )
                    );
                    f.refresh.mockImplementation(() =>
                        outcome === "ok"
                            ? Effect.succeed({ accessToken: `t${++issued}`, userId: "alice" })
                            : Effect.fail(
                                  outcome === "revoked"
                                      ? connectError("NeedsAuthentication", "Refresh token revoked.")
                                      : connectError("Provider", "Provider unreachable.", true)
                              )
                    );
                    const access = yield* acquireConfiguredConnection({
                        manager: f.manager,
                        serviceInstanceId: "stack",
                        oauth,
                        browserAuthentication: f.browser,
                    });
                    let signedOut = false;
                    for (let step = 0; step < 6; step++) {
                        // The service stops accepting every token issued so far.
                        if (next() < 0.5) validFrom = issued + 1;
                        const roll = next();
                        outcome = roll < 0.6 ? "ok" : roll < 0.8 ? "unavailable" : "revoked";
                        const rejected = validFrom > issued;
                        const gets = 1 + Math.floor(next() * 3);
                        const posts = Math.floor(next() * 3);
                        const refreshesBefore = f.refresh.mock.calls.length;
                        const sentBefore = received.length;
                        const results = yield* Effect.all(
                            [
                                ...Array.from({ length: gets }, (_, index) =>
                                    access.egress.fetch(`https://service.test/get-${step}-${index}`)
                                ),
                                ...Array.from({ length: posts }, (_, index) =>
                                    access.egress.fetch(`https://service.test/post-${step}-${index}`, {
                                        method: "POST",
                                        body: "payload",
                                    })
                                ),
                            ].map((request) => Effect.result(request)),
                            { concurrency: "unbounded" }
                        );
                        const refreshes = f.refresh.mock.calls.length - refreshesBefore;
                        const sent = received.slice(sentBefore);
                        // Once signed out, nothing reaches the service or the provider.
                        if (signedOut) {
                            expect([refreshes, sent.length]).toEqual([0, 0]);
                            expect(results.every((result) => result._tag === "Failure")).toBe(true);
                            continue;
                        }
                        // One renewal, however many requests the service rejected.
                        expect(refreshes).toBe(rejected ? 1 : 0);
                        // A body is never sent twice.
                        for (let index = 0; index < posts; index++)
                            expect(
                                sent.filter((line) => line === `POST /post-${step}-${index}`)
                            ).toHaveLength(1);
                        for (const [index, result] of results.entries()) {
                            const post = index >= gets;
                            if (!rejected || (outcome === "ok" && !post)) {
                                expect(result._tag === "Success" && result.success.status).toBe(200);
                            } else if (outcome === "ok" || outcome === "unavailable") {
                                expect(result).toMatchObject({
                                    _tag: "Failure",
                                    failure: {
                                        kind: "Unavailable",
                                        retryable: true,
                                        actionOutcome: "not-committed",
                                    },
                                });
                            } else {
                                expect(result).toMatchObject({
                                    _tag: "Failure",
                                    failure: { kind: "Unauthenticated" },
                                });
                            }
                        }
                        signedOut = rejected && outcome === "revoked";
                        expect(access.authentication.state.status).toBe(signedOut ? "needs-auth" : "active");
                        // An unavailable provider leaves the token rejected; the next step retries.
                        if (rejected && outcome === "unavailable") validFrom = issued + 1;
                    }
                })
            )
        );
    }
}, 60_000);
