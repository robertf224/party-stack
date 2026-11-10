import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectByteBlob } from "@party-stack/runtime";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { NodeFileSystemBlobBytesStore } from "./NodeFileSystemBlobBytesStore.js";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map(async (directory) => {
            const store = new NodeFileSystemBlobBytesStore({
                directory,
            });
            await Effect.runPromise(store.clear());
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

        await Effect.runPromise(store.write("../../outside", new Blob(["hello"])));

        await expect(
            (
                await Effect.runPromise(
                    collectByteBlob((await Effect.runPromise(store.read("../../outside")))!)
                )
            ).text()
        ).resolves.toBe("hello");
        expect(await Effect.runPromise(store.read("outside"))).toBeUndefined();
    });

    it("deletes missing and existing blobs idempotently", async () => {
        const directory = await mkdtemp(join(tmpdir(), "party-stack-blobs-"));
        directories.push(directory);
        const store = new NodeFileSystemBlobBytesStore({
            directory,
        });

        await Effect.runPromise(store.write("one", new Blob(["one"])));
        await Effect.runPromise(store.delete("one"));
        await Effect.runPromise(store.delete("one"));

        expect(await Effect.runPromise(store.read("one"))).toBeUndefined();
    });
});
