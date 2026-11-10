import { Effect, Redacted } from "effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeKeyMaterialStore } from "./NodeKeyMaterialStore.js";

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
            if (native.unavailable) return Effect.fail(new Error("Native credential operation failed."));
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

describe("NodeKeyMaterialStore", () => {
    beforeEach(() => {
        native.calls = 0;
        native.unavailable = false;
        native.entries.clear();
        vi.clearAllMocks();
    });
    it("hashes service/accounts, passes redacted passwords and deletes missing entries safely", async () => {
        const store = await Effect.runPromise(makeKeyMaterialStore({ service: "party-stack:test:secrets" }));
        await Effect.runPromise(store.set("tokens/client:id", "secret"));
        expect(native.set).toHaveBeenCalledWith(
            expect.stringMatching(/^party-stack\.[a-f0-9]{64}$/),
            expect.stringMatching(/^party-stack\.[a-f0-9]{64}$/),
            expect.anything()
        );
        expect(Redacted.value(native.set.mock.calls[0]![2])).toBe("secret");
        await expect(Effect.runPromise(store.get("tokens/client:id"))).resolves.toBe("secret");
        await Effect.runPromise(store.delete("tokens/client:id"));
        await Effect.runPromise(store.delete("tokens/client:id"));
        await expect(Effect.runPromise(store.get("tokens/client:id"))).resolves.toBeUndefined();
        expect(native.remove).toHaveBeenCalledTimes(2);
    });
    it("loads the native service lazily once", async () => {
        const store = await Effect.runPromise(makeKeyMaterialStore({ service: "test" }));
        expect(native.calls).toBe(0);
        await Effect.runPromise(store.get("one"));
        await Effect.runPromise(store.get("two"));
        expect(native.calls).toBe(1);
    });
    it("fails explicitly when the native binding is unavailable", async () => {
        native.unavailable = true;
        const store = await Effect.runPromise(makeKeyMaterialStore({ service: "test" }));
        await expect(Effect.runPromise(store.get("token"))).rejects.toMatchObject({
            _tag: "RuntimeError",
            operation: "secrets",
        });
    });
});
