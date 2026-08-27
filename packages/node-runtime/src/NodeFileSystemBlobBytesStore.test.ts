import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeFileSystemBlobBytesStore } from "./NodeFileSystemBlobBytesStore.js";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map(async (directory) => {
            const store = new NodeFileSystemBlobBytesStore({
                directory,
            });
            await store.clear();
        })
    );
});

describe("NodeFileSystemBlobBytesStore", () => {
    it("round-trips bytes and treats ids as opaque values", async () => {
        const directory = await mkdtemp(join(tmpdir(), "party-stack-blobs-"));
        directories.push(directory);
        const store = new NodeFileSystemBlobBytesStore({
            directory,
        });

        await store.write("../../outside", new Blob(["hello"]));

        await expect((await store.read("../../outside")).text()).resolves.toBe("hello");
        await expect(store.read("outside")).rejects.toThrow('Blob bytes not found for "outside".');
    });

    it("deletes missing and existing blobs idempotently", async () => {
        const directory = await mkdtemp(join(tmpdir(), "party-stack-blobs-"));
        directories.push(directory);
        const store = new NodeFileSystemBlobBytesStore({
            directory,
        });

        await store.write("one", new Blob(["one"]));
        await store.delete("one");
        await store.delete("one");

        await expect(store.read("one")).rejects.toThrow('Blob bytes not found for "one".');
    });
});
