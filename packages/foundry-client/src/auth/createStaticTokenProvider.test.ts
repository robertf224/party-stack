import { describe, expect, it } from "vitest";
import { createStaticTokenProvider } from "./createStaticTokenProvider.js";

describe("createStaticTokenProvider", () => {
    it("returns a static token", async () => {
        const provider = createStaticTokenProvider({ token: "token-1" });
        await expect(provider()).resolves.toBe("token-1");
        await expect(provider()).resolves.toBe("token-1");
    });

    it("supports sync and async token resolvers", async () => {
        await expect(createStaticTokenProvider({ token: () => "sync" })()).resolves.toBe("sync");
        await expect(
            createStaticTokenProvider({
                token: () => Promise.resolve("async"),
            })()
        ).resolves.toBe("async");
    });

    it("rejects empty tokens", async () => {
        await expect(createStaticTokenProvider({ token: "" })()).rejects.toThrow(/empty token/);
        await expect(createStaticTokenProvider({ token: () => "" })()).rejects.toThrow(/empty token/);
    });
});
