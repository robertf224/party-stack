import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ExpoSecretStore } from "./ExpoSecretStore.js";

const secureStore = vi.hoisted(() => ({
    deleteItemAsync: vi.fn((key: string) => {
        void key;
        return Promise.resolve();
    }),
    getItemAsync: vi.fn((key: string) => {
        void key;
        return Promise.resolve(null);
    }),
    setItemAsync: vi.fn((key: string, value: string) => {
        void key;
        void value;
        return Promise.resolve();
    }),
}));

vi.mock("expo-secure-store", () => secureStore);

describe("ExpoSecretStore", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("encodes namespaced keys using only SecureStore-safe characters", async () => {
        const store = new ExpoSecretStore("party-stack:user@example.com:oauth");

        await store.set("tokens/client:id", "secret");

        const key = secureStore.setItemAsync.mock.calls[0]?.[0];
        expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
        expect(key).not.toContain("user@example.com");
        expect(secureStore.setItemAsync).toHaveBeenCalledWith(key, "secret");
    });

    it("separates prefix and key without collisions", async () => {
        await new ExpoSecretStore("a").set("b:c", "one");
        await new ExpoSecretStore("a:b").set("c", "two");

        expect(secureStore.setItemAsync.mock.calls[0]?.[0]).not.toBe(
            secureStore.setItemAsync.mock.calls[1]?.[0]
        );
    });
});

// The same native access policy must apply when reading, writing and deleting an item.
it("forwards authentication policy without silently falling back on failure", async () => {
    const options = { requireAuthentication: true, authenticationPrompt: "Unlock private data" };
    const store = new ExpoSecretStore("private", options);
    await store.set("key", "secret");
    await store.get("key");
    await store.delete("key");
    expect(secureStore.setItemAsync).toHaveBeenLastCalledWith(expect.any(String), "secret", options);
    expect(secureStore.getItemAsync).toHaveBeenLastCalledWith(expect.any(String), options);
    expect(secureStore.deleteItemAsync).toHaveBeenLastCalledWith(expect.any(String), options);
    secureStore.getItemAsync.mockRejectedValueOnce(new Error("Authentication cancelled"));
    await expect(store.get("key")).rejects.toThrow("Authentication cancelled");
});
