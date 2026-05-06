import { describe, expect, it } from "vitest";
import { InMemoryBlobBytesAdapter, InMemoryBlobMetadataAdapter } from "./memory/adapters.js";
import { createBlobStore } from "./store/createBlobStore.js";
import {
    createBlobManager,
    createInMemoryBlobStore,
} from "./index.js";

describe("createBlobStore", () => {
    it("stages bytes and metadata under the same logical id", async () => {
        const store = createInMemoryBlobStore("test", { now: () => 100 });

        const ref = await store.stage(
            "attachment-1",
            new File(["hello"], "hello.txt", { type: "text/plain" })
        );

        expect(ref).toMatchObject({
            id: "attachment-1",
            name: "hello.txt",
            size: 5,
            state: "staged",
            type: "text/plain",
        });
        await expect(store.read("attachment-1")).resolves.toBeInstanceOf(Blob);
    });

    it("marks staged blobs as persisted after materialization", async () => {
        const store = createInMemoryBlobStore("test");
        await store.stage("local-id", new Blob(["hello"]));

        const ref = await store.markPersisted("local-id");

        expect(ref).toMatchObject({
            id: "local-id",
            state: "persisted",
        });
    });

    it("caches remote bytes with store-owned metadata", async () => {
        const store = createInMemoryBlobStore("test", { now: () => 100 });

        const ref = await store.cache(
            "remote-id",
            new File(["remote"], "remote.txt", { type: "text/plain" })
        );

        expect(ref).toMatchObject({
            id: "remote-id",
            name: "remote.txt",
            size: 6,
            state: "cached",
            type: "text/plain",
            lastAccessedAt: 100,
        });
        await expect(store.read("remote-id")).resolves.toBeInstanceOf(Blob);
    });

    it("recovers staging metadata after bytes are present", async () => {
        const bytes = new InMemoryBlobBytesAdapter();
        const metadata = new InMemoryBlobMetadataAdapter();
        const store = createBlobStore({
            name: "test",
            bytes: () => bytes,
            metadata: () => metadata,
            now: () => 100,
        });

        await metadata.put({
            id: "attachment-1",
            type: "text/plain",
            size: 5,
            state: "staging",
            createdAt: 100,
            updatedAt: 100,
        });
        await bytes.write("attachment-1", new Blob(["hello"], { type: "text/plain" }));

        await store.reconcile();

        await expect(store.get("attachment-1")).resolves.toMatchObject({
            id: "attachment-1",
            state: "staged",
        });
    });
});

describe("createBlobManager", () => {
    it("pulls remote bytes through the local cache", async () => {
        const store = createInMemoryBlobStore("test");
        const remoteBlob = new Blob(["remote"], { type: "text/plain" });
        const manager = createBlobManager({
            store,
            remote: {
                metadata: (id) => Promise.resolve({ id, size: 6, type: "text/plain", name: "remote.txt" }),
                blob: () => Promise.resolve(remoteBlob),
            },
        });

        await expect(manager.blob("remote-id")).resolves.toBe(remoteBlob);
        await expect(store.get("remote-id")).resolves.toMatchObject({
            id: "remote-id",
            name: "remote.txt",
            state: "cached",
        });
    });

    it("runs scheduled GC through the configured eviction policy", async () => {
        const store = createInMemoryBlobStore("test", { now: () => 100 });
        const scheduled: Array<() => void> = [];
        const manager = createBlobManager({
            store,
            remote: {
                metadata: (id) => Promise.resolve({ id, size: 6, type: "text/plain", name: "remote.txt" }),
                blob: () => Promise.resolve(new Blob(["remote"], { type: "text/plain" })),
            },
            gcScheduler: (run) => scheduled.push(run),
            gcReleaseBufferSize: 0,
            evictionStrategy: (candidates) => candidates.map((candidate) => candidate.ref.id),
        });

        await manager.blob("remote-id");
        manager.release("remote-id");
        scheduled.forEach((run) => run());
        await new Promise((resolve) => setTimeout(resolve, 0));

        await expect(store.get("remote-id")).resolves.toBeUndefined();
    });

    it("evicts released blobs with the default eviction policy", async () => {
        const store = createInMemoryBlobStore("test", { now: () => 100 });
        const scheduled: Array<() => void> = [];
        const manager = createBlobManager({
            store,
            remote: {
                metadata: (id) => Promise.resolve({ id, size: 6, type: "text/plain", name: "remote.txt" }),
                blob: () => Promise.resolve(new Blob(["remote"], { type: "text/plain" })),
            },
            gcScheduler: (run) => scheduled.push(run),
            gcReleaseBufferSize: 0,
        });

        await manager.blob("remote-id");
        manager.retain("remote-id");
        manager.release("remote-id");
        scheduled.forEach((run) => run());
        await new Promise((resolve) => setTimeout(resolve, 0));

        await expect(store.get("remote-id")).resolves.toBeUndefined();
    });

    it("keeps retained blobs during default eviction", async () => {
        const store = createInMemoryBlobStore("test", { now: () => 100 });
        const scheduled: Array<() => void> = [];
        const manager = createBlobManager({
            store,
            remote: {
                metadata: (id) => Promise.resolve({ id, size: 6, type: "text/plain", name: "remote.txt" }),
                blob: () => Promise.resolve(new Blob(["remote"], { type: "text/plain" })),
            },
            gcScheduler: (run) => scheduled.push(run),
            gcReleaseBufferSize: 0,
        });

        manager.retain("remote-id");
        await manager.blob("remote-id");
        manager.release("other-id");
        scheduled.forEach((run) => run());
        await new Promise((resolve) => setTimeout(resolve, 0));

        await expect(store.get("remote-id")).resolves.toMatchObject({
            id: "remote-id",
            state: "cached",
        });
    });

    it("uploads staged blobs and updates lifecycle state", async () => {
        const store = createInMemoryBlobStore("test");
        const manager = createBlobManager({
            store,
            remote: {
                metadata: (id) => Promise.resolve({ id, size: 0, type: "", name: "" }),
                blob: () => Promise.reject(new Error("unexpected remote read")),
            },
        });
        await manager.stage("local-id", new Blob(["hello"], { type: "text/plain" }));

        await manager.withUploadTracking("local-id", async (blob) => {
            await expect(store.get("local-id")).resolves.toMatchObject({
                state: "uploading",
            });
            expect(await blob.text()).toBe("hello");
        });

        await expect(store.get("local-id")).resolves.toMatchObject({
            id: "local-id",
            state: "persisted",
        });
    });

    it("skips uploads for already persisted blobs", async () => {
        const store = createInMemoryBlobStore("test");
        const manager = createBlobManager({
            store,
            remote: {
                metadata: (id) => Promise.resolve({ id, size: 0, type: "", name: "" }),
                blob: () => Promise.reject(new Error("unexpected remote read")),
            },
        });
        await manager.stage("local-id", new Blob(["hello"]));
        await manager.withUploadTracking("local-id", () => Promise.resolve());

        await manager.withUploadTracking("local-id", () => {
            throw new Error("unexpected second upload");
        });

        await expect(store.get("local-id")).resolves.toMatchObject({
            id: "local-id",
            state: "persisted",
        });
    });
});
