import { beforeEach, describe, expect, it, vi } from "vitest";
import { NodeSecretStore } from "./NodeSecretStore.js";
import type { SecretStorageBackend } from "cross-keychain";

const keychain = vi.hoisted(() => ({
    getAllBackends: vi.fn(),
}));

vi.mock("cross-keychain", () => keychain);

function memoryBackend(id = "native-macos"): SecretStorageBackend {
    const values = new Map<string, string>();
    return {
        id,
        name: id,
        priority: 10,
        getPassword(service, account) {
            return Promise.resolve(values.get(`${service}:${account}`) ?? null);
        },
        setPassword(service, account, password) {
            values.set(`${service}:${account}`, password);
            return Promise.resolve();
        },
        deletePassword(service, account) {
            values.delete(`${service}:${account}`);
            return Promise.resolve();
        },
        getCredential() {
            return Promise.resolve(null);
        },
        withProperties() {
            return this;
        },
        diagnose() {
            return Promise.resolve({});
        },
    };
}

describe("NodeSecretStore", () => {
    beforeEach(() => {
        keychain.getAllBackends.mockReset();
    });

    it("namespaces and hashes keychain accounts", async () => {
        const backend = memoryBackend();
        keychain.getAllBackends.mockResolvedValue([backend]);
        const setPassword = vi.spyOn(backend, "setPassword");
        const store = new NodeSecretStore({
            service: "party-stack:test:secrets",
        });

        await store.set("tokens/client:id", "secret");

        expect(setPassword).toHaveBeenCalledWith(
            expect.stringMatching(/^party-stack\.[a-f0-9]{64}$/),
            expect.stringMatching(/^party-stack\.[a-f0-9]{64}$/),
            "secret"
        );
        await expect(store.get("tokens/client:id")).resolves.toBe("secret");
        await store.delete("tokens/client:id");
        await store.delete("tokens/client:id");
    });

    it("rejects file-only keychain availability", async () => {
        keychain.getAllBackends.mockResolvedValue([memoryBackend("file")]);
        const store = new NodeSecretStore({
            service: "party-stack:test:secrets",
        });

        await expect(store.get("token")).rejects.toThrow("No OS keychain is available");
    });

    it("selects the Linux Secret Service lazily", async () => {
        keychain.getAllBackends.mockResolvedValue([memoryBackend("secret-service")]);
        const store = new NodeSecretStore({
            service: "party-stack:test:secrets",
        });

        expect(keychain.getAllBackends).not.toHaveBeenCalled();
        await expect(store.get("token")).resolves.toBeUndefined();
        expect(keychain.getAllBackends).toHaveBeenCalledOnce();
    });
});
