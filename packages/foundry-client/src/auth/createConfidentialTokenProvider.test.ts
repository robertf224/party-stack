import { describe, expect, it, vi } from "vitest";
import {
    createConfidentialTokenProvider,
    TokenProviderError,
} from "./createConfidentialTokenProvider.js";

function jsonResponse(body: unknown, init?: { status?: number; ok?: boolean }): Response {
    const status = init?.status ?? 200;
    return {
        ok: init?.ok ?? (status >= 200 && status < 300),
        status,
        statusText: status === 200 ? "OK" : "Error",
        text: () => Promise.resolve(JSON.stringify(body)),
    } as Response;
}

describe("createConfidentialTokenProvider", () => {
    it("acquires an initial token with client credentials and scopes", async () => {
        const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
            expect(url).toBe("https://foundry.example/multipass/api/oauth2/token");
            expect(init?.method).toBe("POST");
            expect(init?.headers).toMatchObject({
                "Content-Type": "application/x-www-form-urlencoded",
            });
            const rawBody = init?.body;
            const body = new URLSearchParams(
                typeof rawBody === "string" || rawBody instanceof URLSearchParams
                    ? rawBody
                    : ""
            );
            expect(Object.fromEntries(body.entries())).toEqual({
                grant_type: "client_credentials",
                client_id: "client",
                client_secret: "secret",
                scope: "api:read-data api:write-data",
            });
            return Promise.resolve(jsonResponse({ access_token: "tok-1", expires_in: 3600 }));
        });

        const provider = createConfidentialTokenProvider({
            foundryUrl: "https://foundry.example",
            clientId: "client",
            clientSecret: "secret",
            scopes: ["api:read-data", "api:write-data"],
            fetch: fetchImpl as typeof fetch,
        });

        await expect(provider()).resolves.toBe("tok-1");
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("caches tokens until near expiry and refreshes afterward", async () => {
        const now = vi.spyOn(Date, "now");
        now.mockReturnValue(1_000_000);
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse({ access_token: "tok-1", expires_in: 120 }))
            .mockResolvedValueOnce(jsonResponse({ access_token: "tok-2", expires_in: 120 }));

        const provider = createConfidentialTokenProvider({
            foundryUrl: "https://foundry.example",
            clientId: "client",
            clientSecret: "secret",
            fetch: fetchImpl as typeof fetch,
            refreshSkewMs: 30_000,
        });

        await expect(provider()).resolves.toBe("tok-1");
        now.mockReturnValue(1_000_000 + 60_000);
        await expect(provider()).resolves.toBe("tok-1");
        now.mockReturnValue(1_000_000 + 100_000);
        await expect(provider()).resolves.toBe("tok-2");
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        now.mockRestore();
    });

    it("deduplicates concurrent refresh requests", async () => {
        let resolveFetch: ((response: Response) => void) | undefined;
        const fetchImpl = vi.fn(
            () =>
                new Promise<Response>((resolve) => {
                    resolveFetch = resolve;
                })
        );

        const provider = createConfidentialTokenProvider({
            foundryUrl: "https://foundry.example",
            clientId: "client",
            clientSecret: "secret",
            fetch: fetchImpl as typeof fetch,
        });

        const first = provider();
        const second = provider();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        resolveFetch?.(jsonResponse({ access_token: "shared", expires_in: 3600 }));
        await expect(Promise.all([first, second])).resolves.toEqual(["shared", "shared"]);
    });

    it("throws useful errors for unsuccessful and malformed responses", async () => {
        const unsuccessful = createConfidentialTokenProvider({
            foundryUrl: "https://foundry.example",
            clientId: "client",
            clientSecret: "secret",
            fetch: (() =>
                Promise.resolve(
                    jsonResponse(
                        { error: "invalid_client", error_description: "bad secret" },
                        { status: 401 }
                    )
                )) as typeof fetch,
        });
        await expect(unsuccessful()).rejects.toBeInstanceOf(TokenProviderError);
        await expect(unsuccessful()).rejects.toThrow(/401.*bad secret/);

        const malformed = createConfidentialTokenProvider({
            foundryUrl: "https://foundry.example",
            clientId: "client",
            clientSecret: "secret",
            fetch: (() =>
                Promise.resolve({
                    ok: true,
                    status: 200,
                    statusText: "OK",
                    text: () => Promise.resolve("not-json"),
                } as Response)) as typeof fetch,
        });
        await expect(malformed()).rejects.toThrow(/not valid JSON/);

        const missingToken = createConfidentialTokenProvider({
            foundryUrl: "https://foundry.example",
            clientId: "client",
            clientSecret: "secret",
            fetch: (() => Promise.resolve(jsonResponse({ expires_in: 60 }))) as typeof fetch,
        });
        await expect(missingToken()).rejects.toThrow(/access_token/);
    });

    it("uses a custom fetch implementation", async () => {
        const fetchImpl = vi.fn(() =>
            Promise.resolve(jsonResponse({ access_token: "custom", expires_in: 60 }))
        );
        const provider = createConfidentialTokenProvider({
            foundryUrl: "https://foundry.example/",
            clientId: "client",
            clientSecret: "secret",
            fetch: fetchImpl as typeof fetch,
        });
        await expect(provider()).resolves.toBe("custom");
        expect(fetchImpl).toHaveBeenCalledWith(
            "https://foundry.example/multipass/api/oauth2/token",
            expect.any(Object)
        );
    });
});
