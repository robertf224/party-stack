import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeKeyMaterialStore } from "./ExpoKeyMaterialStore.js";

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

describe("ExpoKeyMaterialStore", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("encodes namespaced keys using only SecureStore-safe characters", async () => {
        const store = makeKeyMaterialStore("party-stack:user@example.com:oauth");

        await Effect.runPromise(store.set("tokens/client:id", "secret"));

        const key = secureStore.setItemAsync.mock.calls[0]?.[0];
        expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
        expect(key).not.toContain("user@example.com");
        expect(secureStore.setItemAsync).toHaveBeenCalledWith(key, "secret");
    });

    it("separates prefix and key without collisions", async () => {
        await Effect.runPromise(makeKeyMaterialStore("a").set("b:c", "one"));
        await Effect.runPromise(makeKeyMaterialStore("a:b").set("c", "two"));

        expect(secureStore.setItemAsync.mock.calls[0]?.[0]).not.toBe(
            secureStore.setItemAsync.mock.calls[1]?.[0]
        );
    });
});

it("uses SecureStore without an additional authentication requirement", async () => {
    const store = makeKeyMaterialStore("background-credentials");
    await Effect.runPromise(store.set("token", "secret"));
    await Effect.runPromise(store.get("token"));
    await Effect.runPromise(store.delete("token"));
    expect(secureStore.setItemAsync).toHaveBeenLastCalledWith(expect.any(String), "secret");
    expect(secureStore.getItemAsync).toHaveBeenLastCalledWith(expect.any(String));
    expect(secureStore.deleteItemAsync).toHaveBeenLastCalledWith(expect.any(String));
});
