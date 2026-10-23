import { Effect, Redacted } from "effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { NodeSecretStore } from "./NodeSecretStore.js";

const native = vi.hoisted(() => ({
    calls: 0,
    unavailable: false,
    entries: new Map<string, string>(),
    set: vi.fn(),
    remove: vi.fn(),
}));
vi.mock("@party-stack/effect-node-keyring", async () => {
    const { Effect, Redacted } = await import("effect");
    return {
        make: Effect.suspend(() => {
            native.calls++;
            if (native.unavailable) return Effect.fail(new Error("Native keyring unavailable"));
            return Effect.succeed({
                getPassword: (service: string, account: string) =>
                    Effect.sync(() => {
                        const value = native.entries.get(JSON.stringify([service, account]));
                        return value === undefined ? undefined : Redacted.make(value);
                    }),
                setPassword: (service: string, account: string, value: Redacted.Redacted<string>) =>
                    Effect.sync(() => {
                        native.set(service, account, value);
                        native.entries.set(JSON.stringify([service, account]), Redacted.value(value));
                    }),
                deleteCredential: (service: string, account: string) =>
                    Effect.sync(() => {
                        native.remove(service, account);
                        return native.entries.delete(JSON.stringify([service, account]));
                    }),
            });
        }),
    };
});

describe("NodeSecretStore", () => {
    beforeEach(() => {
        native.calls = 0;
        native.unavailable = false;
        native.entries.clear();
        vi.clearAllMocks();
    });
    it("hashes service/accounts, passes redacted passwords and deletes missing entries safely", async () => {
        const store = new NodeSecretStore({ service: "party-stack:test:secrets" });
        await store.set("tokens/client:id", "secret");
        expect(native.set).toHaveBeenCalledWith(
            expect.stringMatching(/^party-stack\.[a-f0-9]{64}$/),
            expect.stringMatching(/^party-stack\.[a-f0-9]{64}$/),
            expect.anything()
        );
        expect(Redacted.value(native.set.mock.calls[0]![2])).toBe("secret");
        await expect(store.get("tokens/client:id")).resolves.toBe("secret");
        await store.delete("tokens/client:id");
        await store.delete("tokens/client:id");
        await expect(store.get("tokens/client:id")).resolves.toBeUndefined();
        expect(native.remove).toHaveBeenCalledTimes(2);
    });
    it("loads the native service lazily once", async () => {
        const store = new NodeSecretStore({ service: "test" });
        expect(native.calls).toBe(0);
        await store.get("one");
        await store.get("two");
        expect(native.calls).toBe(1);
    });
    it("fails explicitly when the native binding is unavailable", async () => {
        native.unavailable = true;
        const store = new NodeSecretStore({ service: "test" });
        await expect(store.get("token")).rejects.toThrow("Native keyring unavailable");
    });
});
