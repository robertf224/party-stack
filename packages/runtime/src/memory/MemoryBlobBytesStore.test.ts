import { collectByteBlob } from "@party-stack/ontology-storage/blobs";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { MemoryBlobBytesStore } from "./MemoryBlobBytesStore.js";

describe("MemoryBlobBytesStore", () => {
    it("lazily stores bytes, reads a source, and deletes idempotently", async () => {
        const store = new MemoryBlobBytesStore();
        const write = store.write("folder/blob", new Blob(["hello"]));
        expect(store.blobs.size).toBe(0);
        await Effect.runPromise(write);
        const source = await Effect.runPromise(store.read("folder/blob"));
        expect(source).toBeDefined();
        const blob = await Effect.runPromise(collectByteBlob(source!));
        expect(await blob.text()).toBe("hello");
        await Effect.runPromise(store.delete("folder/blob"));
        await Effect.runPromise(store.delete("folder/blob"));
        expect(await Effect.runPromise(store.read("folder/blob"))).toBeUndefined();
    });
});
