import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createExpoRuntime } from "./createExpoRuntime.js";

const state = vi.hoisted(() => ({
    events: [] as string[],
    close: vi.fn(),
    delete: vi.fn(),
    open: vi.fn(),
    disconnect: vi.fn(),
    clear: vi.fn(),
    directory: vi.fn(),
}));
vi.mock("expo-crypto", () => ({
    CryptoDigestAlgorithm: { SHA256: "SHA-256" },
    digestStringAsync: (_algorithm: string, value: string) =>
        Promise.resolve(createHash("sha256").update(value).digest("hex")),
}));
vi.mock("expo-sqlite", () => ({ openDatabaseAsync: state.open, deleteDatabaseAsync: state.delete }));
vi.mock("@tanstack/expo-db-sqlite-persistence", () => ({ createExpoSQLitePersistence: () => ({}) }));
vi.mock("./ExpoNetworkConnectivity.js", () => ({
    ExpoNetworkConnectivity: { create: () => Promise.resolve({ close: state.disconnect }) },
}));
vi.mock("./ExpoFileSystemBlobBytesStore.js", () => ({
    ExpoFileSystemBlobBytesStore: class {
        constructor(options: unknown) {
            state.directory(options);
        }
        clear = state.clear;
    },
}));
vi.mock("./ExpoSecretStore.js", () => ({ ExpoSecretStore: class {} }));
vi.mock("./createExpoBrowserAuthentication.js", () => ({ createExpoBrowserAuthentication: () => ({}) }));

describe("createExpoRuntime", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        state.events = [];
        state.close.mockImplementation(async () => {
            await Promise.resolve();
            state.events.push("closed");
        });
        state.delete.mockImplementation(() => {
            state.events.push("deleted");
            return Promise.resolve();
        });
        state.open.mockResolvedValue({ closeAsync: state.close });
    });

    it("hashes logical partition names into bounded filesystem names without ambiguous separators", async () => {
        const owner = "../user@example.com/".repeat(100);
        const runtime = await createExpoRuntime(owner, "namespace");
        expect(runtime.owner).toBe(owner);
        const name = `party-stack-${createHash("sha256")
            .update(JSON.stringify([owner, "namespace"]))
            .digest("hex")}`;
        expect(state.open).toHaveBeenCalledWith(`${name}.db`);
        expect(state.directory).toHaveBeenCalledWith({ directoryName: `${name}-blobs` });
        await runtime.cleanup?.();
        const a = await createExpoRuntime("a:b", "c");
        const b = await createExpoRuntime("a", "b:c");
        expect(state.open.mock.calls[1]?.[0]).not.toBe(state.open.mock.calls[2]?.[0]);
        await a.cleanup?.();
        await b.cleanup?.();
    });

    it.each([false, true])(
        "closes before deleting and makes cleanup/destroy idempotent (cleanup first: %s)",
        async (cleanupFirst) => {
            const runtime = await createExpoRuntime("owner", "namespace");
            if (cleanupFirst) await runtime.cleanup?.();
            await Promise.all([runtime.destroy?.(), runtime.cleanup?.(), runtime.destroy?.()]);
            expect(state.close).toHaveBeenCalledTimes(1);
            expect(state.disconnect).toHaveBeenCalledTimes(1);
            expect(state.delete).toHaveBeenCalledTimes(1);
            expect(state.clear).toHaveBeenCalledTimes(1);
            expect(state.events).toEqual(["closed", "deleted"]);
        }
    );

    it("does not delete the database if closing it fails", async () => {
        state.close.mockRejectedValue(new Error("close failed"));
        const runtime = await createExpoRuntime("owner", "namespace");
        await expect(runtime.destroy?.()).rejects.toThrow("close failed");
        expect(state.delete).not.toHaveBeenCalled();
    });
});
