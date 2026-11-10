import { unauthenticated, type BackendError } from "@party-stack/ontology-backend";
import { validate } from "@party-stack/ontology-spec";
import { makeEncryptedValues } from "@party-stack/ontology-storage/encrypted";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Clock, Deferred, Effect, Fiber, Schema, Stream } from "effect";
import { Temporal } from "temporal-polyfill";
import { expect, test, vi } from "vite-plus/test";
import { makeConnectBackend } from "./core/backend.js";
import { connectError } from "./core/errors.js";
import { connectPublicOntologyIR } from "./publicOntology.js";
import { makeServiceConnections } from "./serviceConnections.js";
import type { ServiceConnector } from "./ServiceConnector.js";

const setup = Effect.fnUntraced(function* (services: readonly ServiceConnector[]) {
    const tables = yield* Memory.make();
    const key = yield* Effect.promise(() =>
        crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
    );
    const values = makeEncryptedValues("services", {
        active: Effect.succeed({ id: "key", key }),
        get: () => Effect.succeed(key),
    });
    return yield* makeConnectBackend({
        tables,
        namespace: "services",
        values: { ...values, evict: () => Effect.void },
        services,
    });
});

test("a connection monitor rereads persisted state after delayed watch acquisition", async () => {
    let watching = 0;
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const service: ServiceConnector = {
                    service: "test",
                    acquire: ({ handlers }) => Effect.succeed(handlers),
                };
                const { backend, store } = yield* setup([service]);
                yield* store.put("ServiceInstance", {
                    id: "test",
                    title: "Test",
                    service: "test",
                    instanceUrl: "https://test.example",
                });
                yield* store.put("ExternalSessionConnection", {
                    id: "alice",
                    title: "Alice",
                    serviceInstance: "test",
                    userId: "alice",
                    status: "active",
                    sessionId: "test-session",
                });
                const started = yield* Deferred.make<void>();
                const register = yield* Deferred.make<void>();
                const connections = yield* makeServiceConnections({
                    store,
                    services: [service],
                    backend: {
                        ...backend,
                        changes: {
                            ...backend.changes!,
                            watch: Effect.gen(function* () {
                                yield* Deferred.succeed(started, undefined);
                                yield* Deferred.await(register);
                                yield* Effect.acquireRelease(
                                    Effect.sync(() => {
                                        watching++;
                                    }),
                                    () =>
                                        Effect.sync(() => {
                                            watching--;
                                        })
                                );
                                return yield* backend.changes!.watch!;
                            }),
                        },
                    },
                });
                const access = yield* connections.acquire({
                    objectType: "ExternalSessionConnection",
                    id: "alice",
                });
                yield* Deferred.await(started);
                expect(watching).toBe(0);
                const row = (yield* store.get("ExternalSessionConnection", "alice"))!;
                yield* store.put("ExternalSessionConnection", { ...row, status: "needs-auth" });
                const observed = yield* access.authentication.changes.pipe(
                    Stream.filter((state) => state.status === "needs-auth"),
                    Stream.take(1),
                    Stream.runDrain,
                    Effect.forkScoped
                );
                yield* Deferred.succeed(register, undefined);
                yield* Fiber.join(observed);
                expect(watching).toBe(1);
                expect(access.authentication.state.status).toBe("needs-auth");
            })
        )
    );
    expect(watching).toBe(0);
});

test("concrete connection actions verify identity before committing and return no credentials", async () => {
    expect(validate(connectPublicOntologyIR).kind).toBe("ok");
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const service: ServiceConnector = {
                    service: "test",
                    apiKey: ({ apiKey }) =>
                        apiKey === "private-key"
                            ? Effect.succeed({ userId: "alice" })
                            : Effect.fail(connectError("NeedsAuthentication", "Invalid key")),
                    externalSession: ({ sessionId }) =>
                        sessionId === "verified-session"
                            ? Effect.succeed({ userId: "bob" })
                            : Effect.fail(connectError("NeedsAuthentication", "Invalid session")),
                    acquire: ({ handlers }) => Effect.succeed(handlers),
                };
                const { backend, store } = yield* setup([service]);
                yield* store.put("ServiceInstance", {
                    id: "test",
                    title: "Test",
                    service: "test",
                    instanceUrl: "https://test.example",
                });
                const rejected = yield* Effect.result(
                    backend.applyAction({
                        id: "bad",
                        name: "attachExternalSession",
                        parameters: { serviceInstanceId: "test", sessionId: "invented" },
                    })
                );
                expect(rejected).toMatchObject({ _tag: "Failure", failure: { kind: "Unauthenticated" } });
                expect(yield* store.load("ExternalSessionConnection", {})).toEqual([]);
                const apiKey = yield* backend.applyAction({
                    id: "key",
                    name: "connectApiKey",
                    parameters: { serviceInstanceId: "test", apiKey: "private-key" },
                });
                const id = (apiKey.result as { connectionId: string }).connectionId;
                expect(JSON.stringify(apiKey)).not.toContain("private-key");
                const row = (yield* store.get("ApiKeyConnection", id))!;
                expect(row.userId).toBe("alice");
                expect(row.apiKey?.ciphertext).toContain("party-stack:encrypted:");
                const attached = yield* backend.applyAction({
                    id: "attach",
                    name: "attachExternalSession",
                    parameters: { serviceInstanceId: "test", sessionId: "verified-session" },
                });
                expect(
                    (yield* store.get(
                        "ExternalSessionConnection",
                        (attached.result as { connectionId: string }).connectionId
                    ))?.userId
                ).toBe("bob");
                yield* backend.applyAction({
                    id: "disconnect",
                    name: "disconnectApiKey",
                    parameters: { connectionId: id },
                });
                expect(yield* store.get("ApiKeyConnection", id)).toMatchObject({
                    status: "inactive",
                    apiKey: undefined,
                });
            })
        )
    );
});

test("forgetting an external account removes it even when the service cannot revoke its session", async () => {
    const revoke = vi.fn(() => Effect.fail(connectError("Provider", "Revocation unavailable")));
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { backend, store } = yield* setup([
                    {
                        service: "test",
                        disconnectExternalSession: revoke,
                        acquire: ({ handlers }) => Effect.succeed(handlers),
                    },
                ]);
                yield* store.put("ServiceInstance", {
                    id: "test",
                    title: "Test",
                    service: "test",
                    instanceUrl: "https://test.example",
                });
                yield* store.put("ExternalSessionConnection", {
                    id: "alice",
                    title: "Alice",
                    userId: "alice",
                    serviceInstance: "test",
                    sessionId: "private-session",
                    status: "active",
                });
                const request = {
                    id: "forget",
                    name: "forgetExternalSession",
                    parameters: { connectionId: "alice" },
                };
                expect(yield* Effect.result(backend.applyAction(request))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "Unavailable" },
                });
                expect(yield* store.get("ExternalSessionConnection", "alice")).toBeUndefined();
                yield* backend.applyAction(request);
                expect(revoke).toHaveBeenCalledOnce();
            })
        )
    );
});

test("session acquisition shares only scoped resources and reads current credentials on each request", async () => {
    const closed = vi.fn();
    const acquired = vi.fn();
    const sent: string[] = [];
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const service: ServiceConnector = {
                    service: "test",
                    acquire: Effect.fnUntraced(function* ({ credential, handlers }) {
                        acquired();
                        yield* Effect.addFinalizer(() => Effect.sync(closed));
                        return {
                            fetch: Effect.fnUntraced(function* (request: Request) {
                                const headers = new Headers(request.headers);
                                headers.set("Authorization", `Bearer ${yield* credential}`);
                                return yield* handlers.fetch(new Request(request, { headers }));
                            }),
                            createWebSocket: (url, protocols) => handlers.createWebSocket(url, protocols),
                        };
                    }),
                };
                const { backend, store } = yield* setup([service]);
                yield* store.put("ServiceInstance", {
                    id: "test",
                    title: "Test",
                    service: "test",
                    instanceUrl: "https://test.example",
                });
                const key = yield* Effect.promise(() =>
                    crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
                );
                // Use the backend's ordinary encrypted property path with a deterministic test decryptor.
                let token = "first";
                const manager = yield* makeServiceConnections({
                    store,
                    backend: { ...backend, encrypted: { decrypt: () => Effect.succeed({ value: token }) } },
                    services: [service],
                    handlers: {
                        fetch: (request) => {
                            sent.push(request.headers.get("Authorization")!);
                            return Effect.succeed(new Response());
                        },
                        createWebSocket: () => Effect.die("No socket in this test"),
                    },
                });
                const values = makeEncryptedValues("key", {
                    active: Effect.succeed({ id: "key", key }),
                    get: () => Effect.succeed(key),
                });
                yield* store.put("ApiKeyConnection", {
                    id: "alice",
                    title: "Alice",
                    serviceInstance: "test",
                    userId: "alice",
                    status: "active",
                    apiKey: yield* values.encrypt(Schema.String, "handle"),
                });
                yield* Effect.scoped(
                    Effect.gen(function* () {
                        const one = yield* manager.acquire({ objectType: "ApiKeyConnection", id: "alice" });
                        const two = yield* manager.acquire({ objectType: "ApiKeyConnection", id: "alice" });
                        expect(one).toBe(two);
                        yield* one.egress.fetch("https://test.example");
                        token = "second";
                        yield* two.egress.fetch("https://test.example");
                        const current = (yield* store.get("ApiKeyConnection", "alice"))!;
                        yield* store.put("ApiKeyConnection", {
                            ...current,
                            status: "inactive",
                            apiKey: undefined,
                        });
                        const denied = yield* Effect.result(one.egress.fetch("https://test.example"));
                        expect(denied).toMatchObject({
                            _tag: "Failure",
                            failure: { kind: "Unauthenticated" },
                        });
                        expect(yield* store.get("ApiKeyConnection", "alice")).toMatchObject({
                            status: "inactive",
                        });
                    })
                );
                expect(acquired).toHaveBeenCalledTimes(1);
                expect(closed).toHaveBeenCalledTimes(1);
            })
        )
    );
    expect(sent).toEqual(["Bearer first", "Bearer second"]);
});

test("a late authentication failure cannot pause a newly saved credential", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const started = yield* Deferred.make<void>();
                const reply = yield* Deferred.make<void>();
                const service: ServiceConnector = {
                    service: "test",
                    acquire: ({ credential }) =>
                        Effect.succeed({
                            fetch: () =>
                                Effect.gen(function* () {
                                    yield* credential;
                                    yield* Deferred.succeed(started, undefined);
                                    yield* Deferred.await(reply);
                                    return yield* unauthenticated("Old token rejected");
                                }),
                            createWebSocket: () => Effect.die("unused"),
                        }),
                };
                const { backend, store } = yield* setup([service]);
                yield* store.put("ServiceInstance", {
                    id: "test",
                    title: "Test",
                    service: "test",
                    instanceUrl: "https://test.example",
                });
                const record = {
                    id: "alice",
                    title: "Alice",
                    serviceInstance: "test",
                    userId: "alice",
                    status: "active" as const,
                    apiKey: { ciphertext: "old-test-handle" },
                };
                yield* store.put("ApiKeyConnection", record);
                const manager = yield* makeServiceConnections({
                    store,
                    backend: {
                        ...backend,
                        encrypted: { decrypt: (handle) => Effect.succeed({ value: handle.ciphertext }) },
                    },
                    services: [service],
                });
                const session = yield* manager.acquire({ objectType: "ApiKeyConnection", id: "alice" });
                const request = yield* session.egress.fetch("https://test.example").pipe(Effect.forkScoped);
                yield* Deferred.await(started);
                yield* store.put("ApiKeyConnection", {
                    ...record,
                    apiKey: { ciphertext: "new-test-handle" },
                });
                yield* Deferred.succeed(reply, undefined);
                expect(yield* Effect.result(Fiber.join(request))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "Unauthenticated" },
                });
                expect(session.authentication.state.status).toBe("active");
                expect(yield* store.get("ApiKeyConnection", "alice")).toMatchObject({
                    status: "active",
                    apiKey: { ciphertext: "new-test-handle" },
                });
            })
        )
    );
});

test("authentication monitors observe saved status through the ordinary journal watch", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const allowNotification = yield* Deferred.make<void>();
                const service: ServiceConnector = {
                    service: "test",
                    acquire: () =>
                        Effect.succeed({
                            fetch: () => Effect.fail(unauthenticated("Rejected credential")),
                            createWebSocket: () => Effect.die("unused"),
                        }),
                };
                const { backend, store } = yield* setup([service]);
                yield* store.put("ServiceInstance", {
                    id: "test",
                    title: "Test",
                    service: "test",
                    instanceUrl: "https://test.example",
                });
                yield* store.put("ApiKeyConnection", {
                    id: "alice",
                    title: "Alice",
                    serviceInstance: "test",
                    userId: "alice",
                    status: "active",
                    apiKey: { ciphertext: "private-test-handle" },
                });
                const connections = yield* makeServiceConnections({
                    store,
                    services: [service],
                    backend: {
                        ...backend,
                        changes: {
                            ...backend.changes!,
                            watch: backend.changes!.watch!.pipe(
                                Effect.map(Stream.tap(() => Deferred.await(allowNotification)))
                            ),
                        },
                    },
                });
                const access = yield* connections.acquire({ objectType: "ApiKeyConnection", id: "alice" });
                expect(yield* Effect.result(access.egress.fetch("https://test.example"))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "Unauthenticated" },
                });
                expect(yield* store.get("ApiKeyConnection", "alice")).toMatchObject({ status: "needs-auth" });
                // No private egress-to-monitor notification bypasses the journal.
                expect(access.authentication.state.status).toBe("active");
                const observed = yield* access.authentication.changes.pipe(
                    Stream.filter((state) => state.status === "needs-auth"),
                    Stream.take(1),
                    Stream.runDrain,
                    Effect.forkScoped
                );
                yield* Deferred.succeed(allowNotification, undefined);
                yield* Fiber.join(observed);
                expect(access.authentication.state.status).toBe("needs-auth");
            })
        )
    );
});

test("saved OAuth identity reopens offline while needs-auth and resumes egress after the ordinary login update", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const acquired = vi.fn();
                const service: ServiceConnector = {
                    service: "test",
                    acquire: Effect.fnUntraced(function* ({ credential, handlers }) {
                        yield* Effect.sync(acquired);
                        return {
                            fetch: Effect.fnUntraced(function* (request: Request) {
                                const headers = new Headers(request.headers);
                                headers.set("Authorization", `Bearer ${yield* credential}`);
                                return yield* handlers.fetch(new Request(request, { headers }));
                            }),
                            createWebSocket: (url, protocols) => handlers.createWebSocket(url, protocols),
                        };
                    }),
                };
                const { backend, store } = yield* setup([service]);
                yield* store.put("ServiceInstance", {
                    id: "test",
                    title: "Test",
                    service: "test",
                    instanceUrl: "https://test.example",
                });
                yield* store.put("OAuthApplication", {
                    id: "app",
                    title: "App",
                    serviceInstance: "test",
                    flow: "authorization-code",
                    clientId: "client",
                });
                const record = {
                    id: "alice",
                    title: "Alice",
                    application: "app",
                    userId: "alice",
                    status: "needs-auth" as const,
                    accessToken: { ciphertext: "expired-access" },
                    accessTokenExpiresAt: Temporal.Instant.fromEpochMilliseconds(0),
                    refreshToken: { ciphertext: "expired-refresh" },
                    refreshTokenExpiresAt: Temporal.Instant.fromEpochMilliseconds(0),
                };
                yield* store.put("OAuthConnection", record);
                const decrypt = vi.fn((value: { ciphertext: string }) =>
                    Effect.succeed({ value: value.ciphertext })
                );
                const apply = vi.fn(backend.applyAction);
                const fetch = vi.fn((_request: Request) => Effect.succeed(new Response("ok")));
                const createWebSocket = vi.fn(() => Effect.die("No socket should open while signed out"));
                const connections = yield* makeServiceConnections({
                    store,
                    services: [service],
                    backend: { ...backend, applyAction: apply, encrypted: { decrypt } },
                    handlers: { fetch, createWebSocket },
                });
                const ref = { objectType: "OAuthConnection", id: "alice" } as const;
                const access = yield* connections.acquire(ref);
                expect(access.userId).toBe("alice");
                expect(access.serviceInstance.id).toBe("test");
                expect(access.authentication.state).toEqual({ status: "needs-auth" });
                expect(decrypt).not.toHaveBeenCalled();
                expect(apply).not.toHaveBeenCalled();
                expect(fetch).not.toHaveBeenCalled();
                for (const request of [
                    access.egress.fetch("https://test.example").pipe(Effect.asVoid),
                    access.egress.createWebSocket("wss://test.example").pipe(Effect.asVoid),
                ])
                    expect(yield* Effect.result(request)).toMatchObject({
                        _tag: "Failure",
                        failure: { kind: "Unauthenticated", retryable: false },
                    });
                expect(decrypt).not.toHaveBeenCalled();
                expect(apply).not.toHaveBeenCalled();
                expect(fetch).not.toHaveBeenCalled();
                expect(createWebSocket).not.toHaveBeenCalled();
                const active = yield* Stream.runDrain(
                    access.authentication.changes.pipe(
                        Stream.filter((state) => state.status === "active"),
                        Stream.take(1)
                    )
                ).pipe(Effect.forkScoped({ startImmediately: true }));
                yield* store.put("OAuthConnection", {
                    ...record,
                    status: "active",
                    accessToken: { ciphertext: "fresh-access" },
                    accessTokenExpiresAt: Temporal.Now.instant().add({ hours: 1 }),
                    refreshTokenExpiresAt: undefined,
                });
                yield* Fiber.join(active);
                expect(access.authentication.state).toEqual({ status: "active" });
                expect(yield* connections.acquire(ref)).toBe(access);
                yield* access.egress.fetch("https://test.example");
                expect(fetch).toHaveBeenCalledOnce();
                expect(fetch.mock.calls[0]![0].headers.get("Authorization")).toBe("Bearer fresh-access");
                expect(apply).not.toHaveBeenCalled();
                expect(acquired).toHaveBeenCalledOnce();
            })
        )
    );
});

const renewableSession = Effect.fnUntraced(function* (
    verify: NonNullable<ServiceConnector["externalSession"]>,
    send: (session: string) => Effect.Effect<Response, BackendError> = () => Effect.succeed(new Response())
) {
    const service: ServiceConnector = {
        service: "renewable",
        externalSession: verify,
        acquire: ({ credential }) =>
            Effect.succeed({
                fetch: () => credential.pipe(Effect.flatMap(send)),
                createWebSocket: () => Effect.die("No socket in this fixture"),
            }),
    };
    const fixture = yield* setup([service]);
    yield* fixture.store.put("ServiceInstance", {
        id: "renewable",
        title: "Renewable",
        service: "renewable",
        instanceUrl: "https://session.test",
    });
    const original = {
        id: "saved",
        title: "Original",
        userId: "alice",
        serviceInstance: "renewable",
        sessionId: "original-session",
        status: "active" as const,
        expiresAt: Temporal.Instant.fromEpochMilliseconds((yield* Clock.currentTimeMillis) - 1),
    };
    yield* fixture.store.put("ExternalSessionConnection", original);
    const connections = yield* makeServiceConnections({ ...fixture, services: [service] });
    const access = yield* connections.acquire({ objectType: "ExternalSessionConnection", id: original.id });
    return { ...fixture, access, original };
});

test("expired external sessions reopen without IO, then revalidate once and journal renewed metadata", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const expiresAt = Temporal.Instant.fromEpochMilliseconds(
                    (yield* Clock.currentTimeMillis) + 60_000
                );
                const started = yield* Deferred.make<void>();
                const reply = yield* Deferred.make<void>();
                const verify = vi.fn(() =>
                    Effect.gen(function* () {
                        yield* Deferred.succeed(started, undefined);
                        yield* Deferred.await(reply);
                        return { userId: "alice", title: "Renewed", expiresAt };
                    })
                );
                const sent = vi.fn((_session: string) => Effect.succeed(new Response()));
                const f = yield* renewableSession(verify, sent);
                yield* f.connect.collectExpired();
                expect(verify).not.toHaveBeenCalled();
                expect(yield* f.store.get("ExternalSessionConnection", "saved")).toMatchObject({
                    status: "active",
                });
                const before = yield* f.backend.changes!.pull({});
                const requests = yield* Effect.all(
                    [
                        f.access.egress.fetch("https://session.test/one"),
                        f.access.egress.fetch("https://session.test/two"),
                    ],
                    { concurrency: "unbounded" }
                ).pipe(Effect.forkScoped);
                yield* Deferred.await(started);
                yield* Deferred.succeed(reply, undefined);
                yield* Fiber.join(requests);
                expect(verify).toHaveBeenCalledOnce();
                expect(sent).toHaveBeenCalledTimes(2);
                expect(sent).toHaveBeenCalledWith("original-session");
                expect(yield* f.store.get("ExternalSessionConnection", "saved")).toMatchObject({
                    status: "active",
                    title: "Renewed",
                    expiresAt,
                });
                const commits = yield* f.backend.changes!.pull({ cursor: before.cursor });
                expect(commits.commits.flatMap((commit) => commit.changes)).toContainEqual(
                    expect.objectContaining({
                        kind: "put",
                        objectType: "ExternalSessionConnection",
                        value: expect.objectContaining({ expiresAt }),
                    })
                );
            })
        )
    );
});

test.each(["Provider", "NeedsAuthentication", "changed-user", "expired"] as const)(
    "external session verification distinguishes %s without forwarding unverified access",
    async (result) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    let recover = false;
                    const expiresAt = Temporal.Instant.fromEpochMilliseconds(
                        (yield* Clock.currentTimeMillis) + 60_000
                    );
                    const send = vi.fn((_session: string) => Effect.succeed(new Response()));
                    const f = yield* renewableSession(() => {
                        if (recover) return Effect.succeed({ userId: "alice", expiresAt });
                        if (result === "Provider" || result === "NeedsAuthentication")
                            return Effect.fail(
                                connectError(result, "Verification failed", result === "Provider")
                            );
                        return Effect.succeed({
                            userId: result === "changed-user" ? "other-user" : "alice",
                            expiresAt:
                                result === "expired" ? Temporal.Instant.fromEpochMilliseconds(0) : expiresAt,
                        });
                    }, send);
                    expect(yield* Effect.result(f.access.egress.fetch("https://session.test"))).toMatchObject(
                        {
                            _tag: "Failure",
                            failure: { kind: result === "Provider" ? "Unavailable" : "Unauthenticated" },
                        }
                    );
                    expect(send).not.toHaveBeenCalled();
                    expect(yield* f.store.get("ExternalSessionConnection", "saved")).toMatchObject({
                        userId: "alice",
                        sessionId: "original-session",
                        status: result === "Provider" ? "active" : "needs-auth",
                    });
                    if (result === "Provider") {
                        recover = true;
                        yield* f.access.egress.fetch("https://session.test");
                        expect(send).toHaveBeenCalledOnce();
                        expect(yield* f.store.get("ExternalSessionConnection", "saved")).toMatchObject({
                            status: "active",
                            expiresAt,
                        });
                    }
                })
            )
        );
    }
);

test("an HTTP authentication failure after renewal still updates the renewed saved account", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const expiresAt = Temporal.Instant.fromEpochMilliseconds(
                    (yield* Clock.currentTimeMillis) + 60_000
                );
                const f = yield* renewableSession(
                    () => Effect.succeed({ userId: "alice", expiresAt }),
                    () => Effect.fail(unauthenticated("Session rejected"))
                );
                expect(yield* Effect.result(f.access.egress.fetch("https://session.test"))).toMatchObject({
                    _tag: "Failure",
                });
                expect(yield* f.store.get("ExternalSessionConnection", "saved")).toMatchObject({
                    status: "needs-auth",
                    expiresAt,
                });
            })
        )
    );
});

test.each(["renew", "reconnect", "disconnect", "forget"] as const)(
    "late external session verification cannot overwrite %s",
    async (change) => {
        for (const rejected of [false, true])
            await Effect.runPromise(
                Effect.scoped(
                    Effect.gen(function* () {
                        const started = yield* Deferred.make<void>();
                        const reply = yield* Deferred.make<void>();
                        const now = yield* Clock.currentTimeMillis;
                        const f = yield* renewableSession(() =>
                            Effect.gen(function* () {
                                yield* Deferred.succeed(started, undefined);
                                yield* Deferred.await(reply);
                                if (rejected)
                                    return yield* connectError("NeedsAuthentication", "Old session rejected");
                                return {
                                    userId: "alice",
                                    title: "Stale",
                                    expiresAt: Temporal.Instant.fromEpochMilliseconds(now + 10_000),
                                };
                            })
                        );
                        const pending = yield* f.access.egress
                            .fetch("https://session.test")
                            .pipe(Effect.result, Effect.forkScoped);
                        yield* Deferred.await(started);
                        const newer = {
                            ...f.original,
                            title: "Newer",
                            expiresAt: Temporal.Instant.fromEpochMilliseconds(now + 60_000),
                            sessionId: change === "reconnect" ? "new-session" : f.original.sessionId,
                        };
                        if (change === "renew" || change === "reconnect")
                            yield* f.store.put("ExternalSessionConnection", newer);
                        else
                            yield* f.backend.applyAction({
                                id: "change",
                                name:
                                    change === "forget"
                                        ? "forgetExternalSession"
                                        : "disconnectExternalSession",
                                parameters: { connectionId: "saved" },
                            });
                        yield* Deferred.succeed(reply, undefined);
                        const result = yield* Fiber.join(pending);
                        if (change === "renew" || change === "reconnect") {
                            expect(result._tag).toBe("Success");
                            expect(yield* f.store.get("ExternalSessionConnection", "saved")).toEqual(newer);
                        } else if (change === "forget") {
                            expect(result._tag).toBe("Failure");
                            expect(yield* f.store.get("ExternalSessionConnection", "saved")).toBeUndefined();
                        } else {
                            expect(result._tag).toBe("Failure");
                            expect(yield* f.store.get("ExternalSessionConnection", "saved")).toMatchObject({
                                status: "inactive",
                            });
                        }
                    })
                )
            );
    }
);
