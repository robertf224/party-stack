import { createHash } from "node:crypto";
import { Stream } from "effect";
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
            state.files.set(this.name, new Uint8Array(0));
        }
        writableStream() {
            return new WritableStream<Uint8Array>({
                write: (bytes) => {
                    const previous = state.files.get(this.name) ?? new Uint8Array(0);
                    const next = new Uint8Array(previous.length + bytes.length);
                    next.set(previous);
                    next.set(bytes, previous.length);
                    state.files.set(this.name, next);
                },
            });
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

    it("removes an incomplete immutable generation when its source fails", async () => {
        const store = new ExpoFileSystemBlobBytesStore({ directoryName: "attachments" });
        await store.write("existing", new Blob(["original"]));
        const stream = Stream.concat(
            Stream.succeed(new Uint8Array([1])),
            Stream.fail(new Error("byte read failed"))
        );
        await expect(store.write("new-generation", { stream, type: "" })).rejects.toThrow("byte read failed");
        expect([...state.files.values()]).toEqual([new TextEncoder().encode("original")]);
    });
});
