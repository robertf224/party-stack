import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "./client.js";
import { createFoundryWebSocket } from "./network.js";

describe("createClient", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("treats a supplied fetch as already authenticated", async () => {
        const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            void input;
            void init;
            return Promise.resolve(new Response());
        });
        const tokenProvider = vi.fn(() => Promise.reject(new Error("Unexpected token access.")));
        const createWebSocket = vi.fn(() => Promise.resolve({} as WebSocket));
        const client = createClient({
            baseUrl: "https://foundry.example.com",
            fetch,
            tokenProvider,
            createWebSocket,
        });

        await client.fetch("https://foundry.example.com/api");

        expect(fetch).toHaveBeenCalledOnce();
        expect(tokenProvider).not.toHaveBeenCalled();
        expect(client.createWebSocket).toBe(createWebSocket);
    });

    it("uses tokenProvider when creating its default fetch", async () => {
        const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            void input;
            void init;
            return Promise.resolve(new Response());
        });
        vi.stubGlobal("fetch", fetch);
        const client = createClient({
            baseUrl: "https://foundry.example.com",
            tokenProvider: () => Promise.resolve("token"),
        });

        await client.fetch("https://foundry.example.com/api");

        const request = fetch.mock.calls[0]?.[0];
        expect(request).toBeInstanceOf(Request);
        expect((request as Request).headers.get("authorization")).toBe("Bearer token");
        expect(client.createWebSocket).toBeTypeOf("function");
    });

    it("creates origin-restricted authenticated WebSockets", async () => {
        const createWebSocket = vi.fn((url: string | URL, protocols?: string | string[]) => {
            void url;
            void protocols;
            return {} as WebSocket;
        });
        const factory = createFoundryWebSocket({
            baseUrl: "https://foundry.example.com",
            tokenProvider: () => Promise.resolve("token"),
            createWebSocket,
        });

        await factory("wss://foundry.example.com/stream", ["custom"]);

        expect(createWebSocket).toHaveBeenCalledWith("wss://foundry.example.com/stream", [
            "Bearer-token",
            "custom",
        ]);
    });

    it("rejects cross-origin authenticated requests before loading credentials", async () => {
        const tokenProvider = vi.fn(() => Promise.resolve("token"));
        const client = createClient({
            baseUrl: "https://foundry.example.com",
            tokenProvider,
        });

        await expect(client.fetch("https://example.com/api")).rejects.toThrow(
            'Egress not allowed for origin "https://example.com".'
        );
        expect(tokenProvider).not.toHaveBeenCalled();
    });

    it("rejects cross-origin WebSockets before loading credentials", async () => {
        const tokenProvider = vi.fn(() => Promise.resolve("token"));
        const createWebSocket = vi.fn(() => ({}) as WebSocket);
        const factory = createFoundryWebSocket({
            baseUrl: "https://foundry.example.com",
            tokenProvider,
            createWebSocket,
        });

        await expect(factory("wss://example.com/stream")).rejects.toThrow(
            'Egress not allowed for origin "https://example.com".'
        );
        expect(tokenProvider).not.toHaveBeenCalled();
        expect(createWebSocket).not.toHaveBeenCalled();
        await expect(factory("/stream")).rejects.toBeInstanceOf(TypeError);
        expect(tokenProvider).not.toHaveBeenCalled();
    });
});
