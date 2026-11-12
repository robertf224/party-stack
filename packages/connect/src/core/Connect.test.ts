import { o } from "@party-stack/ontology-spec";
import { makeEncryptedValues } from "@party-stack/ontology-storage/encrypted";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Effect, Schema, Scope, Exit } from "effect";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import { makeConnectServer } from "../server/index.js";
import { connectOntology } from "../spec/index.js";
import { connectError } from "./errors.js";
import { makeOAuthAuthority, type ConnectOAuthService } from "./oauthAuthority.js";
import { makeConnectStore } from "./store.js";

const run = Effect.runPromise;
const scopes: Scope.Closeable[] = [];
afterEach(async () => {
    for (const scope of scopes.splice(0)) await run(Scope.close(scope, Exit.void));
});
const time = (delta: number) => Temporal.Instant.fromEpochMilliseconds(Date.now() + delta);
async function fixture(extended = false) {
    const tables = await run(Memory.make());
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
    ]);
    const cryptoValues = makeEncryptedValues("connect", {
        active: Effect.succeed({ id: "key", key }),
        get: () => Effect.succeed(key),
    });
    const values = { ...cryptoValues, evict: vi.fn(() => Effect.void) };
    const ir = structuredClone(connectOntology);
    if (extended) {
        ir.objectTypes
            .find((object) => object.name === "OAuthConnection")!
            .properties.push({ name: "project", displayName: "Project", type: o.string({}) } as never);
        ir.objectTypes
            .find((object) => object.name === "OAuthAuthorizationAttempt")!
            .properties.push({ name: "project", displayName: "Project", type: o.string({}) } as never);
    }
    const scope = Effect.runSync(Scope.make());
    scopes.push(scope);
    const store = await run(Scope.provide(makeConnectStore({ tables, namespace: "connect", ir }), scope));
    await run(
        store.put("ServiceInstance", {
            id: "serviceInstance",
            title: "Example",
            service: "example",
            instanceUrl: "https://example.com",
        })
    );
    await run(
        store.put("OAuthApplication", {
            id: "application",
            title: "Example",
            serviceInstance: "serviceInstance",
            clientId: "app",
            flow: "authorization-code",
        })
    );
    const exchange = vi.fn(() =>
        Effect.succeed({
            accessToken: "access",
            refreshToken: "refresh",
            accessTokenExpiresAt: time(3_600_000),
            userId: "user",
        })
    );
    const refresh = vi.fn(() =>
        Effect.succeed({
            accessToken: "new-access",
            refreshToken: "rotated",
            accessTokenExpiresAt: time(3_600_000),
            userId: "user",
        })
    );
    const oauth: ConnectOAuthService = {
        authorizationUrl: (input) =>
            Effect.succeed(
                `https://auth.example/authorize?state=${input.state}&code_challenge=${input.codeChallenge}`
            ),
        exchange,
        refresh,
        clientCredentials: Effect.succeed({ accessToken: "service-access", userId: "service" }),
    };
    const connect = await run(
        makeOAuthAuthority({
            store,
            values,
            oauth: () => Effect.succeed(oauth),
            connectionProperties: extended
                ? (attempt) =>
                      Effect.succeed({ project: (attempt as unknown as { project: string }).project })
                : undefined,
        })
    );
    const begin = (connectionId?: string) =>
        run(
            connect.begin({
                applicationId: "application",
                connectionId,
                principalId: "principal",
                redirectUrl: "https://app.example/connect/callback",
                properties: extended ? { project: "project-1" } : undefined,
            })
        );
    const complete = (id: string, principalId = "principal") =>
        run(
            connect.complete({
                principalId,
                callbackUrl: `https://app.example/connect/callback?state=${id}&code=secret-code`,
            })
        );
    return { tables, values, store, connect, oauth, exchange, refresh, begin, complete };
}

describe("Connect authority", () => {
    it("persists encrypted tokens, consumes PKCE once and resumes a completed callback", async () => {
        const f = await fixture();
        const started = await f.begin();
        const attempt = (await run(f.store.get("OAuthAuthorizationAttempt", started.id)))!;
        expect(await run(f.values.decrypt(Schema.String, attempt.codeVerifier))).not.toBe("");
        const connection = await f.complete(started.id);
        expect(
            await run(
                f.values.decrypt(
                    Schema.String,
                    (await run(f.store.get("OAuthConnection", connection.id)))!.accessToken!
                )
            )
        ).toBe("access");
        expect(connection.accessToken?.ciphertext).not.toContain("access");
        expect((await f.complete(started.id)).id).toBe(connection.id);
        expect(f.exchange).toHaveBeenCalledTimes(1);
        expect((await run(f.store.get("OAuthApplication", "application")))?.connection).toBe(connection.id);
    });
    it("checks principal, expiry, callback location and prevents duplicate in-flight exchanges", async () => {
        const f = await fixture();
        const { id } = await f.begin();
        expect(
            (
                await run(
                    Effect.flip(
                        f.connect.complete({
                            principalId: "other",
                            callbackUrl: `https://app.example/connect/callback?state=${id}`,
                        })
                    )
                )
            ).kind
        ).toBe("InvalidAttempt");
        expect(
            (
                await run(
                    Effect.flip(
                        f.connect.complete({
                            principalId: "principal",
                            callbackUrl: `https://evil.example/connect/callback?state=${id}`,
                        })
                    )
                )
            ).kind
        ).toBe("InvalidAttempt");
        const attempt = (await run(f.store.get("OAuthAuthorizationAttempt", id)))!;
        await run(f.store.put("OAuthAuthorizationAttempt", { ...attempt, status: "exchanging" }));
        await expect(f.complete(id)).rejects.toThrow(/consumed/);
        expect(f.exchange).not.toHaveBeenCalled();
        await run(f.store.put("OAuthAuthorizationAttempt", { ...attempt, expiresAt: time(-1000) }));
        await expect(f.complete(id)).rejects.toThrow(/unavailable/);
    });
    it("reopens durable attempts and credentials with a new service", async () => {
        const f = await fixture();
        const { id } = await f.begin();
        const next = await run(
            makeOAuthAuthority({ store: f.store, values: f.values, oauth: () => Effect.succeed(f.oauth) })
        );
        const connection = await run(
            next.complete({
                principalId: "principal",
                callbackUrl: `https://app.example/connect/callback?state=${id}&code=code`,
            })
        );
        expect(await run(f.values.decrypt(Schema.String, connection.accessToken!))).toBe("access");
    });
    it("rotates credentials atomically and replaces embedded ciphertext", async () => {
        const f = await fixture();
        const connection = await f.complete((await f.begin()).id);
        const next = await run(f.connect.refresh(connection.id));
        expect(
            await run(
                f.values.decrypt(
                    Schema.String,
                    (await run(f.store.get("OAuthConnection", connection.id)))!.accessToken!
                )
            )
        ).toBe("new-access");
        expect(await run(f.values.decrypt(Schema.String, next.refreshToken!))).toBe("rotated");
        expect(next.operationId).toBeUndefined();
    });
    it("retains identity and valid access on terminal refresh failure, without rolling back cleanup", async () => {
        const f = await fixture();
        const connection = await f.complete((await f.begin()).id);
        f.oauth.refresh = () => Effect.fail(connectError("NeedsAuthentication", "Reconnect."));
        await expect(run(f.connect.refresh(connection.id))).rejects.toThrow(/Reconnect/);
        const next = (await run(f.store.get("OAuthConnection", connection.id)))!;
        expect(next.status).toBe("needs-auth");
        expect(next.refreshToken).toBeUndefined();
        expect(next.operationId).toBeUndefined();
        expect(
            await run(
                f.values.decrypt(
                    Schema.String,
                    (await run(f.store.get("OAuthConnection", connection.id)))!.accessToken!
                )
            )
        ).toBe("access");
    });
    it("keeps credentials after a definite transient oauth failure", async () => {
        const f = await fixture();
        const connection = await f.complete((await f.begin()).id);
        f.oauth.refresh = () => Effect.fail(connectError("Provider", "Unavailable", true));
        await expect(run(f.connect.refresh(connection.id))).rejects.toThrow(/Unavailable/);
        const next = (await run(f.store.get("OAuthConnection", connection.id)))!;
        expect(next.refreshToken).toEqual(connection.refreshToken);
        expect(next.operationId).toBeUndefined();
        expect(next.status).toBe("active");
    });
    it("guards refresh across service instances", async () => {
        const f = await fixture();
        const connection = await f.complete((await f.begin()).id);
        await run(
            f.store.put("OAuthConnection", {
                ...connection,
                operationId: "other-process",
                operationExpiresAt: time(60_000),
            })
        );
        const other = await run(
            makeOAuthAuthority({ store: f.store, values: f.values, oauth: () => Effect.succeed(f.oauth) })
        );
        expect((await run(Effect.flip(other.refresh(connection.id)))).kind).toBe("Busy");
        expect(f.refresh).not.toHaveBeenCalled();
    });
    it("requires explicit reconnect after interrupted refresh and allows that repair", async () => {
        const f = await fixture();
        const connection = await f.complete((await f.begin()).id);
        await run(
            f.store.put("OAuthConnection", {
                ...connection,
                operationId: "dead-process",
                operationExpiresAt: time(-1000),
            })
        );
        expect((await run(Effect.flip(f.connect.refresh(connection.id)))).kind).toBe("NeedsAuthentication");
        const next = await run(
            f.connect.begin({
                applicationId: "application",
                connectionId: connection.id,
                principalId: "principal",
                redirectUrl: "https://app.example/connect/callback",
            })
        );
        const repaired = await f.complete(next.id);
        expect(repaired.id).toBe(connection.id);
        expect(repaired.operationId).toBeUndefined();
    });
    it("cleans up expired refresh secrets and attempts in bounded indexed batches", async () => {
        const f = await fixture();
        const connection = await f.complete((await f.begin()).id);
        await run(f.store.put("OAuthConnection", { ...connection, refreshTokenExpiresAt: time(-1000) }));
        const started = await f.begin();
        const attempt = (await run(f.store.get("OAuthAuthorizationAttempt", started.id)))!;
        await run(f.store.put("OAuthAuthorizationAttempt", { ...attempt, expiresAt: time(-1000) }));
        expect(await run(f.connect.collectExpired({ limit: 1 }))).toEqual({ attempts: 1, refreshTokens: 1 });
        expect(await run(f.store.get("OAuthAuthorizationAttempt", started.id))).toBeUndefined();
        expect((await run(f.store.get("OAuthConnection", connection.id)))?.status).toBe("needs-auth");
        expect(
            await run(
                f.values.decrypt(
                    Schema.String,
                    (await run(f.store.get("OAuthConnection", connection.id)))!.accessToken!
                )
            )
        ).toBe("access");
    });
    it("preserves application properties on connection writes", async () => {
        const f = await fixture(true);
        const connection = await f.complete((await f.begin()).id);
        await run(f.connect.refresh(connection.id));
        expect(await run(f.store.get("OAuthConnection", connection.id))).toHaveProperty(
            "project",
            "project-1"
        );
    });
    it("keeps client-credentials and interactive connectors separate", async () => {
        const f = await fixture();
        await expect(run(f.connect.clientCredentials({ applicationId: "application" }))).rejects.toThrow(
            /client credentials/
        );
        await run(
            f.store.put("OAuthApplication", {
                id: "service",
                title: "Service",
                serviceInstance: "serviceInstance",
                clientId: "service-app",
                flow: "client-credentials",
            })
        );
        const connection = await run(f.connect.clientCredentials({ applicationId: "service" }));
        expect(
            await run(
                f.values.decrypt(
                    Schema.String,
                    (await run(f.store.get("OAuthConnection", connection.id)))!.accessToken!
                )
            )
        ).toBe("service-access");
        await expect(
            run(
                f.connect.begin({
                    applicationId: "service",
                    principalId: "principal",
                    redirectUrl: "https://app.example/callback",
                })
            )
        ).rejects.toThrow(/interactive/);
    });
    it("disconnect removes local credentials even when revocation fails", async () => {
        const f = await fixture();
        const connection = await f.complete((await f.begin()).id);
        f.oauth.revoke = () => Effect.fail(connectError("Provider", "Unavailable", true));
        await expect(run(f.connect.disconnect(connection.id))).rejects.toThrow(/Unavailable/);
        expect((await run(f.store.get("OAuthConnection", connection.id)))?.status).toBe("inactive");
    });
});

describe("Connect HTTP boundary", () => {
    it("completes server-mediated auth and returns no credentials or oauth code", async () => {
        const f = await fixture();
        const authorize = vi.fn(() => Effect.void);
        const handler = makeConnectServer({
            connect: f.connect,
            store: f.store,
            appOrigin: "https://app.example",
            callbackUrl: "https://app.example/connect/callback",
            authenticate: () => Effect.succeed({ id: "person", sessionId: "session" }),
            authorize,
        });
        const started = await run(
            handler(
                new Request("https://app.example/connect/begin", {
                    method: "POST",
                    headers: { Origin: "https://app.example", "Content-Type": "application/json" },
                    body: JSON.stringify({ applicationId: "application", returnUrl: "/done" }),
                })
            )
        );
        const { id } = (await started.json()) as { id: string };
        expect(started.status).toBe(200);
        const callback = await run(
            handler(new Request(`https://app.example/connect/callback?state=${id}&code=private-code`))
        );
        expect(callback.status).toBe(303);
        expect(callback.headers.get("Location")).toBe(
            `https://app.example/done?connectAttempt=${id}&state=${id}`
        );
        const result = await run(handler(new Request(`https://app.example/connect/result?state=${id}`)));
        const body = await result.text();
        expect(body).toContain("completed");
        expect(body).not.toMatch(/access|refresh|private-code/);
        expect(authorize).toHaveBeenCalledTimes(3);
    });
    it("blocks foreign origins, return URLs and changed browser sessions", async () => {
        const f = await fixture();
        let sessionId = "session";
        const handler = makeConnectServer({
            connect: f.connect,
            store: f.store,
            appOrigin: "https://app.example",
            callbackUrl: "https://app.example/connect/callback",
            authenticate: () => Effect.succeed({ id: "person", sessionId }),
            authorize: () => Effect.void,
        });
        const start = (origin: string, returnUrl: string) =>
            run(
                handler(
                    new Request("https://app.example/connect/begin", {
                        method: "POST",
                        headers: { Origin: origin },
                        body: JSON.stringify({ applicationId: "application", returnUrl }),
                    })
                )
            );
        expect((await start("https://evil.example", "/done")).status).toBe(403);
        expect((await start("https://app.example", "https://evil.example")).status).toBe(403);
        const { id } = (await (await start("https://app.example", "/done")).json()) as { id: string };
        sessionId = "other";
        expect(
            (await run(handler(new Request(`https://app.example/connect/callback?state=${id}&code=code`))))
                .status
        ).toBe(400);
        expect(f.exchange).not.toHaveBeenCalled();
    });
});

it("rolls back embedded credentials if saving rotated credentials fails", async () => {
    const f = await fixture();
    const connection = await f.complete((await f.begin()).id);
    let failedHandle: string | undefined;
    const faulted = {
        ...f.store,
        put: <
            N extends
                | "ServiceInstance"
                | "OAuthApplication"
                | "OAuthConnection"
                | "OAuthAuthorizationAttempt"
                | "ApiKeyConnection"
                | "ExternalSessionConnection",
        >(
            name: N,
            value: Parameters<typeof f.store.put<N>>[1]
        ) => {
            if (
                name === "OAuthConnection" &&
                "accessToken" in value &&
                value.accessToken &&
                value.accessToken.ciphertext !== connection.accessToken!.ciphertext
            ) {
                failedHandle = value.accessToken.ciphertext;
                return f.store
                    .put(name, value)
                    .pipe(Effect.andThen(Effect.fail(connectError("Storage", "Injected commit failure"))));
            }
            return f.store.put(name, value);
        },
    };
    const connect = await run(
        makeOAuthAuthority({ store: faulted, values: f.values, oauth: () => Effect.succeed(f.oauth) })
    );
    await expect(run(connect.refresh(connection.id))).rejects.toThrow(/Injected/);
    const stored = (await run(f.store.get("OAuthConnection", connection.id)))!;
    expect(stored.accessToken).toEqual(connection.accessToken);
    expect(stored.refreshToken).toEqual(connection.refreshToken);
    expect(await run(f.values.decrypt(Schema.String, connection.refreshToken!))).toBe("refresh");
    expect(stored.accessToken?.ciphertext).not.toBe(failedHandle);
    expect(stored.operationId).toBeDefined();
});

it("a late refresh response cannot reactivate a disconnected connection", async () => {
    const f = await fixture();
    const connection = await f.complete((await f.begin()).id);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
        release = resolve;
    });
    f.oauth.refresh = () =>
        Effect.promise(() => waiting).pipe(
            Effect.as({ accessToken: "late-access", refreshToken: "late-refresh", userId: "user" })
        );
    const pending = run(f.connect.refresh(connection.id)).catch((error: unknown) => error);
    await vi.waitFor(async () =>
        expect((await run(f.store.get("OAuthConnection", connection.id)))?.operationId).toBeDefined()
    );
    await run(f.connect.disconnect(connection.id));
    release();
    await pending;
    const record = (await run(f.store.get("OAuthConnection", connection.id)))!;
    expect(record.status).toBe("inactive");
    expect(record.accessToken).toBeUndefined();
    expect(record.refreshToken).toBeUndefined();
});

it("can disconnect locally when the decryption key is unavailable", async () => {
    const f = await fixture();
    const connection = await f.complete((await f.begin()).id);
    const connect = await run(
        makeOAuthAuthority({
            store: f.store,
            values: { ...f.values, decrypt: () => Effect.fail(connectError("Storage", "Key unavailable")) },
            oauth: () => Effect.succeed(f.oauth),
        })
    );
    await run(connect.disconnect(connection.id));
    expect((await run(f.store.get("OAuthConnection", connection.id)))?.status).toBe("inactive");
});

it("forget removes the account, credentials and OAuth references without touching other accounts", async () => {
    const f = await fixture();
    const connection = await f.complete((await f.begin()).id);
    const other = {
        id: "other-account",
        application: "application",
        title: "Other",
        userId: "other",
        status: "active" as const,
    };
    await run(f.store.put("OAuthConnection", other));
    const reconnect = await f.begin(connection.id);
    const unrelated = await f.begin();
    f.values.evict.mockClear();
    const revoked = vi.fn(() => Effect.void);
    f.oauth.revoke = revoked;
    await run(f.connect.forget(connection.id));
    expect(await run(f.store.get("OAuthConnection", connection.id))).toBeUndefined();
    expect(await run(f.store.get("OAuthConnection", other.id))).toEqual(other);
    expect(await run(f.store.get("OAuthApplication", "application"))).toHaveProperty("connection", undefined);
    expect(await run(f.connect.connectionForApplication("application"))).toBeUndefined();
    expect(await run(f.store.get("OAuthAuthorizationAttempt", reconnect.id))).toBeUndefined();
    expect(await run(f.store.load("OAuthAuthorizationAttempt", {}))).toMatchObject([{ id: unrelated.id }]);
    expect(revoked).toHaveBeenCalledWith("refresh");
    expect(f.values.evict).toHaveBeenCalledWith(connection.accessToken);
    expect(f.values.evict).toHaveBeenCalledWith(connection.refreshToken);
    await run(f.connect.forget(connection.id));
    expect(revoked).toHaveBeenCalledOnce();
    expect((await f.complete(unrelated.id)).id).not.toBe(connection.id);
});

it("forget commits local deletion even if remote revocation fails", async () => {
    const f = await fixture();
    const connection = await f.complete((await f.begin()).id);
    f.oauth.revoke = () => Effect.fail(connectError("Provider", "Revocation unavailable"));
    await expect(run(f.connect.forget(connection.id))).rejects.toThrow(/Revocation unavailable/);
    expect(await run(f.store.get("OAuthConnection", connection.id))).toBeUndefined();
    expect(await run(f.store.load("OAuthAuthorizationAttempt", {}))).toEqual([]);
    await run(f.connect.forget(connection.id));
});

it("a late refresh cannot recreate a forgotten account", async () => {
    const f = await fixture();
    const connection = await f.complete((await f.begin()).id);
    const started = Effect.runSync(Deferred.make<void>());
    const reply = Effect.runSync(Deferred.make<void>());
    f.oauth.refresh = () =>
        Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(reply);
            return { accessToken: "late-access", refreshToken: "late-refresh", userId: "user" };
        });
    const pending = run(Effect.result(f.connect.refresh(connection.id)));
    await run(Deferred.await(started));
    try {
        await run(f.connect.forget(connection.id));
    } finally {
        await run(Deferred.succeed(reply, undefined));
    }
    expect(await pending).toMatchObject({ _tag: "Failure", failure: { kind: "NotFound" } });
    expect(await run(f.store.get("OAuthConnection", connection.id))).toBeUndefined();
});

it.each([false, true])(
    "a late OAuth exchange cannot recreate a forgotten account or attempt (provider failure: %s)",
    async (fail) => {
        const f = await fixture();
        const connection = await f.complete((await f.begin()).id);
        const reconnect = await f.begin(connection.id);
        const started = Effect.runSync(Deferred.make<void>());
        const reply = Effect.runSync(Deferred.make<void>());
        f.oauth.exchange = () =>
            Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(reply);
                if (fail) return yield* connectError("Provider", "Provider failed");
                return { accessToken: "late-access", refreshToken: "late-refresh", userId: "user" };
            });
        const pending = f.complete(reconnect.id).then(
            () => undefined,
            (error: unknown) => error
        );
        await run(Deferred.await(started));
        try {
            await run(f.connect.forget(connection.id));
        } finally {
            await run(Deferred.succeed(reply, undefined));
        }
        expect(await pending).toBeInstanceOf(Error);
        expect(await run(f.store.get("OAuthConnection", connection.id))).toBeUndefined();
        expect(await run(f.store.get("OAuthAuthorizationAttempt", reconnect.id))).toBeUndefined();
        expect(await run(f.connect.connectionForApplication("application"))).toBeUndefined();
    }
);

it("a repeated login refreshes one connection while trusted ownership properties keep bindings separate", async () => {
    const f = await fixture(true);
    const first = await f.complete((await f.begin()).id);
    const second = await f.complete((await f.begin()).id);
    expect(second.id).toBe(first.id);
    expect(await run(f.store.load("OAuthConnection", {}))).toHaveLength(1);
    const other = await run(
        f.connect.begin({
            applicationId: "application",
            principalId: "principal",
            redirectUrl: "https://app.example/connect/callback",
            properties: { project: "project-2" },
        })
    );
    const third = await f.complete(other.id);
    expect(third.id).not.toBe(first.id);
    expect(await run(f.store.load("OAuthConnection", {}))).toHaveLength(2);
});

describe("native OAuth redirects", () => {
    const registered = "com.example.app://auth/callback";
    const configure = async (f: Awaited<ReturnType<typeof fixture>>, redirectUrl?: string) => {
        const application = (await run(f.store.get("OAuthApplication", "application")))!;
        await run(f.store.put("OAuthApplication", { ...application, redirectUrl }));
    };
    const start = (f: Awaited<ReturnType<typeof fixture>>, redirectUrl: string) =>
        run(
            Effect.result(
                f.connect.begin({ applicationId: "application", principalId: "principal", redirectUrl })
            )
        );
    const finish = (f: Awaited<ReturnType<typeof fixture>>, callbackUrl: string) =>
        run(Effect.result(f.connect.complete({ principalId: "principal", callbackUrl })));

    it("completes PKCE through the application's registered custom-scheme callback", async () => {
        const f = await fixture();
        await configure(f, registered);
        const started = await start(f, registered);
        expect(started._tag).toBe("Success");
        const id = started._tag === "Success" ? started.success.id : "";
        const completed = await finish(f, `${registered}?state=${id}&code=secret-code`);
        expect(completed._tag).toBe("Success");
        expect(f.exchange).toHaveBeenCalledTimes(1);
        // A completed attempt cannot be exchanged again.
        expect((await finish(f, `${registered}?state=${id}&code=other`))._tag).toBe("Success");
        expect(f.exchange).toHaveBeenCalledTimes(1);
    });

    it("rejects custom schemes that the trusted registration does not declare", async () => {
        const f = await fixture();
        expect(await start(f, registered)).toMatchObject({ _tag: "Failure" });
        await configure(f, registered);
        for (const redirectUrl of [
            "com.example.other://auth/callback",
            "javascript://auth/callback",
            "http://app.example/callback",
            `${registered}#fragment`,
        ])
            expect(await start(f, redirectUrl)).toMatchObject({ _tag: "Failure" });
        await configure(f, "javascript://auth/callback");
        expect(await start(f, "javascript://auth/callback")).toMatchObject({ _tag: "Failure" });
        await configure(f, "https://app.example/connect/callback");
        expect(await start(f, "https://app.example/connect/callback")).toMatchObject({ _tag: "Success" });
        expect(await start(f, "http://localhost:3000/callback")).toMatchObject({ _tag: "Failure" });
    });

    it("matches the callback's scheme, host and path to the accepted redirect", async () => {
        const f = await fixture();
        await configure(f, registered);
        const started = await start(f, registered);
        const id = started._tag === "Success" ? started.success.id : "";
        for (const callbackUrl of [
            `com.example.other://auth/callback?state=${id}&code=c`,
            `com.example.app://other/callback?state=${id}&code=c`,
            `com.example.app://auth/other?state=${id}&code=c`,
            `com.example.app://user@auth/callback?state=${id}&code=c`,
            "not a url",
        ])
            expect(await finish(f, callbackUrl)).toMatchObject({
                _tag: "Failure",
                failure: { kind: "InvalidAttempt" },
            });
        expect(f.exchange).not.toHaveBeenCalled();
        expect((await finish(f, `${registered}?state=${id}&code=c`))._tag).toBe("Success");
    });
});
