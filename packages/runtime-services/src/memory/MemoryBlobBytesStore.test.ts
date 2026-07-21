import { describe, expect, it } from "vitest";
import { MemoryBlobBytesStore } from "./MemoryBlobBytesStore.js";

describe("MemoryBlobBytesStore", () => {
    it("stores, lists, reads, and deletes blobs", async () => {
        const store = new MemoryBlobBytesStore();
        await store.write("folder/blob", new Blob(["hello"]));

        expect(await (await store.read("folder/blob")).text()).toBe("hello");
        expect(await store.list()).toEqual(["folder/blob"]);

        await store.delete("folder/blob");
        await expect(store.read("folder/blob")).rejects.toThrow(
            'Blob bytes not found for "folder/blob".'
        );
    });
});
