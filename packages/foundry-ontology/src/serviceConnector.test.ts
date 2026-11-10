import { toWebEgress } from "@party-stack/connect";
import { Effect } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { makeFoundryServiceConnector } from "./serviceConnector.js";

test("saved Foundry connections read current credentials and reject cross-origin egress", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let token = "first";
                const credentials = vi.fn(() => token);
                const fetch = vi.fn((_request: Request) => Effect.succeed(new Response()));
                const socket = vi.fn(() => Effect.succeed({} as WebSocket));
                const nativeEgress = yield* makeFoundryServiceConnector().acquire({
                    connection: {
                        objectType: "OAuthConnection",
                        value: {
                            id: "saved",
                            application: "app",
                            title: "Foundry",
                            userId: "alice",
                            status: "active",
                        },
                    },
                    serviceInstance: {
                        id: "stack",
                        title: "Stack",
                        service: "foundry",
                        instanceUrl: "https://foundry.example",
                    },
                    credential: Effect.sync(credentials),
                    refreshCredential: () => Effect.die("unused"),
                    handlers: { fetch, createWebSocket: socket },
                });
                const egress = yield* toWebEgress(nativeEgress);
                yield* Effect.promise(() => egress.fetch(new Request("https://foundry.example/api/data")));
                expect(fetch.mock.calls[0]![0].headers.get("authorization")).toBe("Bearer first");
                token = "refreshed";
                yield* Effect.promise(() => egress.createWebSocket("wss://foundry.example/socket"));
                expect(socket).toHaveBeenCalledWith("wss://foundry.example/socket", ["Bearer-refreshed"]);
                expect(credentials).toHaveBeenCalledTimes(2);
                yield* Effect.promise(async () => {
                    await expect(
                        egress.fetch(new Request("https://other.example/data"))
                    ).rejects.toMatchObject({ kind: "Forbidden" });
                    await expect(egress.createWebSocket("wss://other.example/socket")).rejects.toMatchObject({
                        kind: "Forbidden",
                    });
                });
                expect(credentials).toHaveBeenCalledTimes(2);
                expect(fetch).toHaveBeenCalledTimes(1);
                expect(socket).toHaveBeenCalledTimes(1);
            })
        )
    );
});

test.each([{ scopes: undefined }, { scopes: ["api:admin-read"] }, { scopes: [] }])(
    "each Foundry OAuth application chooses its requested scopes: %j",
    async ({ scopes }) => {
        const connector = makeFoundryServiceConnector();
        const oauth = await Effect.runPromise(
            connector.oauth!({
                serviceInstance: {
                    id: "stack",
                    title: "Stack",
                    service: "foundry",
                    instanceUrl: "https://foundry.example",
                },
                application: {
                    id: "app",
                    title: "App",
                    serviceInstance: "stack",
                    clientId: "client",
                    flow: "authorization-code",
                    scopes,
                },
                values: {
                    encrypt: () => Effect.die("Not used"),
                    decrypt: () => Effect.die("Not used"),
                    evict: () => Effect.void,
                },
            })
        );
        const url = new URL(
            await Effect.runPromise(
                oauth.authorizationUrl({
                    state: "state",
                    codeChallenge: "proof",
                    redirectUrl: "https://app.test/callback",
                })
            )
        );
        expect(url.searchParams.get("scope") ?? "").toBe((scopes ?? connector.defaultOAuthScopes!).join(" "));
    }
);
