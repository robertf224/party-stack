import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ExpoFileSystemBlobBytesStore } from "./ExpoFileSystemBlobBytesStore.js";

const state = vi.hoisted(() => ({ files: new Map<string, Uint8Array>(), created: vi.fn() }));
vi.mock("expo-crypto", () => ({
    CryptoDigestAlgorithm: { SHA256: "SHA-256" },
    digestStringAsync: (_algorithm: string, value: string) =>
        Promise.resolve(createHash("sha256").update(value).digest("hex")),
}));
vi.mock("expo-file-system", () => ({
    Paths: { document: "documents" },
    Directory: class {
        exists = true;
        create() {}
        delete() {
            state.files.clear();
        }
    },
    File: class {
        constructor(
            _directory: unknown,
            readonly name: string
        ) {}
        get exists() {
            return state.files.has(this.name);
        }
        create() {
            state.created(this.name);
        }
        write(bytes: Uint8Array) {
            state.files.set(this.name, bytes);
        }
        delete() {
            state.files.delete(this.name);
        }
    },
}));

describe("ExpoFileSystemBlobBytesStore", () => {
    beforeEach(() => {
        state.files.clear();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it("writes standard Blob bytes under bounded hashed IDs", async () => {
        const store = new ExpoFileSystemBlobBytesStore({ directoryName: "attachments" });
        const id = "../user/".repeat(500);
        await store.write(id, new Blob(["hello"]));
        expect(state.created).toHaveBeenCalledWith(createHash("sha256").update(id).digest("hex"));
        expect([...state.files.values()][0]).toEqual(new TextEncoder().encode("hello"));
        await expect(store.read(id)).resolves.toBeDefined();
        await store.delete(id);
        await store.delete(id);
        await expect(store.read(id)).rejects.toThrow("Blob bytes not found");
    });

    it("propagates byte read failures before overwriting cached bytes", async () => {
        const store = new ExpoFileSystemBlobBytesStore({ directoryName: "attachments" });
        await store.write("existing", new Blob(["original"]));
        state.created.mockClear();
        const blob = { arrayBuffer: () => Promise.reject(new Error("byte read failed")) } as Blob;
        await expect(store.write("existing", blob)).rejects.toThrow("byte read failed");
        expect(state.created).not.toHaveBeenCalled();
        expect([...state.files.values()][0]).toEqual(new TextEncoder().encode("original"));
    });
});
