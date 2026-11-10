import { byteSource, collectByteBlob } from "@party-stack/runtime";
import { Effect } from "effect";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { OPFSBlobBytesStore } from "./OPFSBlobBytesStore.js";

afterEach(() => vi.unstubAllGlobals());

function filesystem() {
    const directories = new Map<string, Map<string, Blob>>();
    const root = {
        async getDirectoryHandle(name: string) {
            if (!directories.has(name)) directories.set(name, new Map());
            const files = directories.get(name)!;
            return {
                async getFileHandle(name: string, options?: { create?: boolean }) {
                    if (!files.has(name) && !options?.create)
                        throw new DOMException("Missing", "NotFoundError");
                    return {
                        async getFile() {
                            return files.get(name)!;
                        },
                        async createWritable() {
                            const chunks: Uint8Array<ArrayBuffer>[] = [];
                            return new WritableStream<Uint8Array>({
                                write(chunk) {
                                    chunks.push(new Uint8Array(chunk));
                                },
                                close() {
                                    files.set(name, new Blob(chunks));
                                },
                            });
                        },
                    };
                },
                async removeEntry(name: string) {
                    files.delete(name);
                },
            };
        },
        async removeEntry(name: string) {
            directories.delete(name);
        },
    };
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
    return directories;
}
const read = (store: OPFSBlobBytesStore, id: string) =>
    Effect.runPromise(
        Effect.gen(function* () {
            const source = yield* store.read(id);
            if (!source) return undefined;
            const blob = yield* collectByteBlob(source);
            return yield* Effect.promise(() => blob.text());
        })
    );

test("short existing OPFS directory and encoded file names retain their addresses", async () => {
    const directories = filesystem();
    const store = new OPFSBlobBytesStore({ directoryName: 'party-stack:["alice","issues"]:blobs' });
    await Effect.runPromise(store.write("file/id", byteSource(new Blob(["existing"]))));
    expect([...directories.keys()]).toEqual(['party-stack:["alice","issues"]:blobs']);
    expect([...directories.values()][0]!.has("file%2Fid")).toBe(true);
    expect(
        await read(
            new OPFSBlobBytesStore({ directoryName: 'party-stack:["alice","issues"]:blobs' }),
            "file/id"
        )
    ).toBe("existing");
});

test("composite and long partition addresses reopen, remain isolated, and can be forgotten", async () => {
    const directories = filesystem();
    const partition = JSON.stringify([
        JSON.stringify({ tenant: "a/b", user: "alice" }),
        "namespace".repeat(50),
    ]);
    const first = new OPFSBlobBytesStore({ directoryName: partition });
    const second = new OPFSBlobBytesStore({ directoryName: `${partition}:other` });
    const longId = "attachment/".repeat(50);
    await Effect.runPromise(first.write(longId, byteSource(new Blob(["first"]))));
    await Effect.runPromise(second.write(longId, byteSource(new Blob(["second"]))));
    expect(directories.size).toBe(2);
    for (const [name, files] of directories) {
        expect(name).toMatch(/^#[a-f0-9]{64}$/);
        expect([...files.keys()][0]).toMatch(/^#[a-f0-9]{64}$/);
    }
    expect(await read(new OPFSBlobBytesStore({ directoryName: partition }), longId)).toBe("first");
    await Effect.runPromise(first.delete(longId));
    expect(await read(first, longId)).toBeUndefined();
    expect(await read(second, longId)).toBe("second");
    await Effect.runPromise(first.clear());
    expect(directories.size).toBe(1);
    await Effect.runPromise(second.clear());
    expect(directories.size).toBe(0);
});
