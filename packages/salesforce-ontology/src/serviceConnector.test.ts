import { toWebEgress } from "@party-stack/connect";
import { makeEncryptedValues } from "@party-stack/ontology-storage/encrypted";
import { Effect, Schema } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { makeSalesforceServiceConnector } from "./serviceConnector.js";
import type { ServiceConnector } from "@party-stack/connect";

const serviceInstance = {
    id: "org",
    service: "salesforce",
    title: "Org",
    instanceUrl: "https://org.my.salesforce.com",
};
const oauthConnection = {
    objectType: "OAuthConnection" as const,
    value: { id: "saved", application: "app", title: "Alice", userId: "alice", status: "active" as const },
};

test("Salesforce OAuth uses the configured login host and encrypted client secret, then verifies identity", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const key = yield* Effect.promise(() =>
                crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
            );
            const values = {
                ...makeEncryptedValues("salesforce-test", {
                    active: Effect.succeed({ id: "key", key }),
                    get: () => Effect.succeed(key),
                }),
                evict: () => Effect.void,
            };
            const requests: Request[] = [];
            const fetch: typeof globalThis.fetch = async (input, init) => {
                const request = new Request(input, init);
                requests.push(request.clone());
                return request.url.endsWith("/token")
                    ? Response.json({ access_token: "private-token", token_type: "Bearer" })
                    : Response.json({ user_id: "alice" });
            };
            const connector = makeSalesforceServiceConnector({
                loginUrl: "https://login.salesforce.com",
                fetch,
            });
            const oauth = yield* connector.oauth!({
                serviceInstance,
                application: {
                    id: "app",
                    title: "App",
                    serviceInstance: "org",
                    flow: "client-credentials",
                    clientId: "client",
                    scopes: ["api"],
                    clientSecret: yield* values.encrypt(Schema.String, "private-secret"),
                },
                values,
            });
            const url = new URL(
                yield* oauth.authorizationUrl({
                    state: "state",
                    codeChallenge: "challenge",
                    redirectUrl: "https://app.test/callback",
                })
            );
            expect(url.origin).toBe("https://login.salesforce.com");
            expect(url.searchParams.get("scope")).toBe("api");
            expect(yield* oauth.clientCredentials).toMatchObject({
                accessToken: "private-token",
                userId: "alice",
            });
            expect(requests.map((request) => request.url)).toEqual([
                "https://login.salesforce.com/services/oauth2/token",
                "https://login.salesforce.com/services/oauth2/userinfo",
            ]);
            const body = new URLSearchParams(yield* Effect.promise(() => requests[0]!.text()));
            expect(body.get("client_secret")).toBe("private-secret");
            expect(requests[1]!.headers.get("authorization")).toBe("Bearer private-token");
        })
    );
});

test("API-key identity rejects missing IDs and authentication failures", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const connector = makeSalesforceServiceConnector({ fetch });
    fetch.mockResolvedValueOnce(Response.json({ user_id: "alice" }));
    expect(await Effect.runPromise(connector.apiKey!({ serviceInstance, apiKey: "key" }))).toEqual({
        userId: "alice",
    });
    fetch.mockResolvedValueOnce(Response.json({}));
    expect(
        await Effect.runPromise(Effect.result(connector.apiKey!({ serviceInstance, apiKey: "key" })))
    ).toMatchObject({ _tag: "Failure", failure: { kind: "Provider", retryable: false } });
    fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(
        await Effect.runPromise(Effect.result(connector.apiKey!({ serviceInstance, apiKey: "key" })))
    ).toMatchObject({ _tag: "Failure", failure: { kind: "NeedsAuthentication", retryable: false } });
});

test.each(["OAuthConnection", "ApiKeyConnection"] as const)(
    "%s egress confines credentials and retries a rejected OAuth token only once",
    async (objectType) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const requests: Request[] = [];
                    let status = 401;
                    const fetch = vi.fn((request: Request) => {
                        requests.push(request);
                        return Effect.succeed(new Response(null, { status }));
                    });
                    const refresh = vi.fn(() => {
                        status = 200;
                        return Effect.succeed("refreshed");
                    });
                    const connection: Parameters<ServiceConnector["acquire"]>[0]["connection"] =
                        objectType === "OAuthConnection"
                            ? oauthConnection
                            : {
                                  objectType,
                                  value: {
                                      id: "saved",
                                      serviceInstance: "org",
                                      title: "Alice",
                                      userId: "alice",
                                      status: "active",
                                  },
                              };
                    const nativeEgress = yield* makeSalesforceServiceConnector().acquire({
                        serviceInstance,
                        connection,
                        credential: Effect.succeed("original"),
                        refreshCredential: refresh,
                        handlers: { fetch, createWebSocket: () => Effect.die("unused") },
                    });
                    const egress = yield* toWebEgress(nativeEgress);
                    yield* Effect.promise(async () => {
                        await expect(
                            egress.fetch(new Request("https://elsewhere.test/data"))
                        ).rejects.toMatchObject({ kind: "InvalidRequest" });
                        if (objectType === "OAuthConnection") {
                            expect(
                                (
                                    await egress.fetch(
                                        new Request(`${serviceInstance.instanceUrl}/data`, {
                                            method: "POST",
                                            body: "payload",
                                        })
                                    )
                                ).status
                            ).toBe(200);
                            expect(requests.map((request) => request.headers.get("Authorization"))).toEqual([
                                "Bearer original",
                                "Bearer refreshed",
                            ]);
                            expect(await requests[1]!.text()).toBe("payload");
                            expect(refresh).toHaveBeenCalledWith("original");
                            status = 401;
                            refresh.mockImplementation(() => Effect.succeed("still-rejected"));
                            await expect(
                                egress.fetch(new Request(`${serviceInstance.instanceUrl}/data`))
                            ).rejects.toMatchObject({ kind: "Unauthenticated" });
                            expect(fetch).toHaveBeenCalledTimes(4);
                            expect(refresh).toHaveBeenCalledTimes(2);
                        } else {
                            await expect(
                                egress.fetch(new Request(`${serviceInstance.instanceUrl}/data`))
                            ).rejects.toMatchObject({ kind: "Unauthenticated" });
                            expect(refresh).not.toHaveBeenCalled();
                            expect(fetch).toHaveBeenCalledOnce();
                        }
                    });
                })
            )
        );
    }
);
