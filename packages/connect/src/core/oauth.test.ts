import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { connectError } from "./errors.js";
import { makeOAuthService } from "./oauth.js";
import type { ConnectError } from "./errors.js";

const service = (
    fetch: typeof globalThis.fetch,
    resolveSubject: (token: string) => Effect.Effect<string, ConnectError> = () => Effect.succeed("user")
) =>
    makeOAuthService({
        issuer: "https://provider.example",
        authorizationEndpoint: "https://provider.example/authorize",
        tokenEndpoint: "https://provider.example/token",
        clientId: "client",
        clientAuthentication: { method: "none" },
        scopes: ["read"],
        resolveSubject,
        fetch,
    });
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refreshFailure = async (oauth: ReturnType<typeof service>) => {
    const result = await Effect.runPromise(Effect.result(oauth.refresh("saved-refresh-token")));
    return result._tag === "Failure" ? result.failure : undefined;
};

describe("makeOAuthService refresh", () => {
    it("keeps the session when the provider cannot be reached", async () => {
        const error = await refreshFailure(
            service(() => Promise.reject(new TypeError("Network request failed")))
        );
        expect(error).toMatchObject({ kind: "Provider", retryable: true });
    });

    it("asks for a sign-in when the provider rejects the refresh token", async () => {
        const error = await refreshFailure(
            service(() => Promise.resolve(json({ error: "invalid_grant" }, 400)))
        );
        expect(error).toMatchObject({ kind: "NeedsAuthentication" });
    });

    it("keeps the session when refreshed credentials cannot be verified", async () => {
        const error = await refreshFailure(
            service(
                () =>
                    Promise.resolve(json({ access_token: "access", token_type: "bearer", expires_in: 3600 })),
                () => Effect.fail(connectError("Provider", "Could not reach the provider."))
            )
        );
        expect(error).toMatchObject({ kind: "Provider", retryable: true });
    });

    it("keeps a sign-in request from verifying refreshed credentials", async () => {
        const error = await refreshFailure(
            service(
                () =>
                    Promise.resolve(json({ access_token: "access", token_type: "bearer", expires_in: 3600 })),
                () => Effect.fail(connectError("NeedsAuthentication", "Token rejected."))
            )
        );
        expect(error).toMatchObject({ kind: "NeedsAuthentication" });
    });
});
