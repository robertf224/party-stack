import { o } from "@party-stack/ontology-spec";
import { makeEncryptedValues } from "@party-stack/ontology-storage/encrypted";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect, Schema } from "effect";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeConnectServer } from "../server/index.js";
import { connectOntology } from "../spec/index.js";
import { makeConnect, type ConnectOAuthProvider } from "./Connect.js";
import { connectError } from "./errors.js";
import { makeConnectStore } from "./store.js";

const run = Effect.runPromise;
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
    const values = { ...cryptoValues, evict: () => Effect.void };
    const ir = structuredClone(connectOntology);
    if (extended) {
        ir.objectTypes
            .find((object) => object.name === "OAuthConnection")!
            .properties.push({ name: "project", type: o.string({}) } as never);
        ir.objectTypes
            .find((object) => object.name === "OAuthAuthorizationAttempt")!
            .properties.push({ name: "project", type: o.string({}) } as never);
    }
    const store = await run(makeConnectStore({ tables, namespace: "connect", ir }));
    await run(
        store.put("Installation", {
            id: "installation",
            title: "Example",
            providerId: "example",
            instanceUrl: "https://example.com",
        })
    );
    await run(
        store.put("OAuthConnector", {
            id: "connector",
            title: "Example",
            installation: "installation",
            clientId: "app",
            flow: "authorization-code",
        })
    );
    const exchange = vi.fn(() =>
        Effect.succeed({
            accessToken: "access",
            refreshToken: "refresh",
            accessTokenExpiresAt: time(3_600_000),
            providerSubjectId: "user",
        })
    );
    const refresh = vi.fn(() =>
        Effect.succeed({
            accessToken: "new-access",
            refreshToken: "rotated",
            accessTokenExpiresAt: time(3_600_000),
            providerSubjectId: "user",
        })
    );
    const provider: ConnectOAuthProvider = {
        authorizationUrl: (input) =>
            Effect.succeed(
                `https://auth.example/authorize?state=${input.state}&code_challenge=${input.codeChallenge}`
            ),
        exchange,
        refresh,
        clientCredentials: Effect.succeed({ accessToken: "service-access", providerSubjectId: "service" }),
    };
    const connect = await run(
        makeConnect({
            store,
            values,
            provider: () => Effect.succeed(provider),
            connectionProperties: extended
                ? (attempt) =>
                      Effect.succeed({ project: (attempt as unknown as { project: string }).project })
                : undefined,
        })
    );
    const begin = () =>
        run(
            connect.begin({
                connectorId: "connector",
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
    return { tables, values, store, connect, provider, exchange, refresh, begin, complete };
}

describe("Connect authority", () => {
    it("persists encrypted tokens, consumes PKCE once and resumes a completed callback", async () => {
        const f = await fixture();
        const started = await f.begin();
        const attempt = (await run(f.store.get("OAuthAuthorizationAttempt", started.id)))!;
        expect(await run(f.values.decrypt(Schema.String, attempt.codeVerifier))).not.toBe("");
        const connection = await f.complete(started.id);
        expect(await run(f.connect.accessToken(connection.id))).toBe("access");
        expect(connection.accessToken?.ciphertext).not.toContain("access");
        expect((await f.complete(started.id)).id).toBe(connection.id);
        expect(f.exchange).toHaveBeenCalledTimes(1);
        expect((await run(f.store.get("OAuthConnector", "connector")))?.connection).toBe(connection.id);
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
            makeConnect({ store: f.store, values: f.values, provider: () => Effect.succeed(f.provider) })
        );
        const connection = await run(
            next.complete({
                principalId: "principal",
                callbackUrl: `https://app.example/connect/callback?state=${id}&code=code`,
            })
        );
        expect(await run(next.accessToken(connection.id))).toBe("access");
    });
    it("rotates credentials atomically and replaces embedded ciphertext", async () => {
        const f = await fixture();
        const connection = await f.complete((await f.begin()).id);
        const next = await run(f.connect.refresh(connection.id));
        expect(await run(f.connect.accessToken(connection.id))).toBe("new-access");
        expect(await run(f.values.decrypt(Schema.String, next.refreshToken!))).toBe("rotated");
        expect(next.operationId).toBeUndefined();
    });
    it("retains identity and valid access on terminal refresh failure, without rolling back cleanup", async () => {
        const f = await fixture();
        const connection = await f.complete((await f.begin()).id);
        f.provider.refresh = () => Effect.fail(connectError("NeedsAuthentication", "Reconnect."));
        await expect(run(f.connect.refresh(connection.id))).rejects.toThrow(/Reconnect/);
        const next = (await run(f.store.get("OAuthConnection", connection.id)))!;
        expect(next.status).toBe("needs-auth");
        expect(next.refreshToken).toBeUndefined();
        expect(next.operationId).toBeUndefined();
        expect(await run(f.connect.accessToken(connection.id))).toBe("access");
    });
    it("keeps credentials after a definite transient provider failure", async () => {
        const f = await fixture();
        const connection = await f.complete((await f.begin()).id);
        f.provider.refresh = () => Effect.fail(connectError("Provider", "Unavailable", true));
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
            makeConnect({ store: f.store, values: f.values, provider: () => Effect.succeed(f.provider) })
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
                connectorId: "connector",
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
        expect(await run(f.connect.accessToken(connection.id))).toBe("access");
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
        await expect(run(f.connect.clientCredentials({ connectorId: "connector" }))).rejects.toThrow(
            /client credentials/
        );
        await run(
            f.store.put("OAuthConnector", {
                id: "service",
                title: "Service",
                installation: "installation",
                clientId: "service-app",
                flow: "client-credentials",
            })
        );
        const connection = await run(f.connect.clientCredentials({ connectorId: "service" }));
        expect(await run(f.connect.accessToken(connection.id))).toBe("service-access");
        await expect(
            run(
                f.connect.begin({
                    connectorId: "service",
                    principalId: "principal",
                    redirectUrl: "https://app.example/callback",
                })
            )
        ).rejects.toThrow(/interactive/);
    });
    it("disconnect removes local credentials even when revocation fails", async () => {
        const f = await fixture();
        const connection = await f.complete((await f.begin()).id);
        f.provider.revoke = () => Effect.fail(connectError("Provider", "Unavailable", true));
        await expect(run(f.connect.disconnect(connection.id))).rejects.toThrow(/Unavailable/);
        expect((await run(f.store.get("OAuthConnection", connection.id)))?.status).toBe("inactive");
    });
});

describe("Connect HTTP boundary", () => {
    it("completes server-mediated auth and returns no credentials or provider code", async () => {
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
                    body: JSON.stringify({ connectorId: "connector", returnUrl: "/done" }),
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
                        body: JSON.stringify({ connectorId: "connector", returnUrl }),
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
        put: <N extends "Installation" | "OAuthConnector" | "OAuthConnection" | "OAuthAuthorizationAttempt">(
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
        makeConnect({ store: faulted, values: f.values, provider: () => Effect.succeed(f.provider) })
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
    f.provider.refresh = () =>
        Effect.promise(() => waiting).pipe(
            Effect.as({ accessToken: "late-access", refreshToken: "late-refresh", providerSubjectId: "user" })
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
        makeConnect({
            store: f.store,
            values: { ...f.values, decrypt: () => Effect.fail(connectError("Storage", "Key unavailable")) },
            provider: () => Effect.succeed(f.provider),
        })
    );
    await run(connect.disconnect(connection.id));
    expect((await run(f.store.get("OAuthConnection", connection.id)))?.status).toBe("inactive");
});
