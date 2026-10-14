import { describe, expect, it, vi } from "vite-plus/test";
import { createClientCredentialsOAuthClient } from "./createClientCredentialsOAuthClient.js";

describe("createClientCredentialsOAuthClient", () => {
    it("obtains and caches a client credentials token", async () => {
        let requestBody: URLSearchParams | undefined;
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            const request = new Request(input, init);
            requestBody = new URLSearchParams(await request.text());
            return Response.json({
                access_token: "access-token",
                expires_in: 3600,
                token_type: "Bearer",
            });
        });
        const client = createClientCredentialsOAuthClient({
            clientId: "client",
            clientSecret: "secret",
            tokenEndpoint: "https://auth.example/token",
            scopes: ["api"],
            fetch,
            resolveUserId: () => "user-1",
        });

        await expect(client.getAccessToken()).resolves.toBe("access-token");
        await expect(client.getAccessToken()).resolves.toBe("access-token");
        await expect(client.getSession()).resolves.toMatchObject({
            userId: "user-1",
            expiration: {
                refreshable: true,
            },
        });

        expect(fetch).toHaveBeenCalledOnce();
        expect(requestBody?.get("grant_type")).toBe("client_credentials");
        expect(requestBody?.get("client_id")).toBe("client");
        expect(requestBody?.get("client_secret")).toBe("secret");
        expect(requestBody?.get("scope")).toBe("api");
    });

    it("supports basic client authentication and token revocation", async () => {
        const requests: Request[] = [];
        const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
            const request = new Request(input, init);
            requests.push(request);
            return Promise.resolve(
                request.url.endsWith("/revoke")
                    ? new Response(null, {
                          status: 200,
                      })
                    : Response.json({
                          access_token: "access-token",
                          expires_in: 3600,
                      })
            );
        });
        const client = createClientCredentialsOAuthClient({
            clientId: "client",
            clientSecret: "secret",
            tokenEndpoint: "https://auth.example/token",
            tokenEndpointAuthMethod: "client_secret_basic",
            revocationEndpoint: "https://auth.example/revoke",
            fetch,
            resolveUserId: () => "user-1",
        });

        await client.getAccessToken();
        await client.revoke();

        expect(requests).toHaveLength(2);
        for (const request of requests) {
            expect(request.headers.get("authorization")).toBe("Basic Y2xpZW50OnNlY3JldA==");
        }
        expect(new URLSearchParams(await requests[1]!.text()).get("token")).toBe("access-token");
    });
});
