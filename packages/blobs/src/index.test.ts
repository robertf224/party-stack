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

        const ref = await store.markUploaded("local-id");

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

    it("resolves remotely mapped ids to local bytes and metadata", async () => {
        const metadata = new InMemoryBlobMetadataAdapter();
        const store = createBlobStore({
            name: "test",
            bytes: () => new InMemoryBlobBytesAdapter(),
            metadata: () => metadata,
        });
        await store.stage("local-id", new Blob(["hello"], { type: "text/plain" }));

        const ref = await store.markUploaded("local-id", { remoteId: "remote-id" });

        expect(ref).toMatchObject({
            id: "local-id",
            remoteId: "remote-id",
            state: "persisted",
        });
        await expect(store.get("remote-id")).resolves.toMatchObject({
            id: "local-id",
            remoteId: "remote-id",
        });
        metadata.list = () => Promise.reject(new Error("unexpected metadata scan"));
        await expect(store.read("remote-id")).resolves.toBeInstanceOf(Blob);
        await store.purge("remote-id");
        await expect(store.get("local-id")).resolves.toBeUndefined();
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
        scheduled.forEach((run) => run());
        await new Promise((resolve) => setTimeout(resolve, 0));

        await expect(store.get("remote-id")).resolves.toBeUndefined();
    });

    it("keeps blobs retained by external providers during GC", async () => {
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
            retentionProviders: [() => ["local-id"]],
        });

        await manager.stage("local-id", new Blob(["hello"]));
        await manager.blob("remote-id");
        scheduled.forEach((run) => run());
        await new Promise((resolve) => setTimeout(resolve, 0));

        await expect(store.get("local-id")).resolves.toMatchObject({
            id: "local-id",
            state: "staged",
        });
    });

    it("keeps blobs retained by remote id during GC", async () => {
        const store = createInMemoryBlobStore("test", { now: () => 100 });
        const scheduled: Array<() => void> = [];
        const manager = createBlobManager({
            store,
            remote: {
                metadata: (id) =>
                    Promise.resolve({ id, size: 6, type: "text/plain", name: "remote.txt" }),
                blob: () => Promise.resolve(new Blob(["remote"], { type: "text/plain" })),
            },
            gcScheduler: (run) => scheduled.push(run),
            gcReleaseBufferSize: 0,
            retentionProviders: [() => ["remote-local-id"]],
            evictionStrategy: (candidates) =>
                candidates
                    .filter((candidate) => !candidate.retained)
                    .map((candidate) => candidate.ref.id),
        });
        await manager.stage("local-id", new Blob(["hello"]));
        await manager.markUploaded("local-id", { remoteId: "remote-local-id" });

        await manager.blob("remote-id");
        scheduled.forEach((run) => run());
        await new Promise((resolve) => setTimeout(resolve, 0));

        await expect(store.get("local-id")).resolves.toMatchObject({
            id: "local-id",
            remoteId: "remote-local-id",
            state: "persisted",
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
            remoteId: undefined,
            state: "persisted",
        });
    });

    it("marks action-owned uploads as persisted with remote ids", async () => {
        const store = createInMemoryBlobStore("test");
        const manager = createBlobManager({
            store,
            remote: {
                metadata: (id) => Promise.resolve({ id, size: 0, type: "", name: "" }),
                blob: () => Promise.reject(new Error("unexpected remote read")),
            },
        });
        await manager.stage("local-id", new Blob(["hello"]));

        await manager.markUploaded("local-id", { remoteId: "remote-id" });

        await expect(store.get("remote-id")).resolves.toMatchObject({
            id: "local-id",
            remoteId: "remote-id",
            state: "persisted",
        });
    });

    it("dedupes concurrent uploads without a store lock", async () => {
        const store = createInMemoryBlobStore("test");
        const manager = createBlobManager({
            store,
            remote: {
                metadata: (id) => Promise.resolve({ id, size: 0, type: "", name: "" }),
                blob: () => Promise.reject(new Error("unexpected remote read")),
            },
        });
        await manager.stage("local-id", new Blob(["hello"]));
        let uploadCount = 0;
        let finishUpload: (() => void) | undefined;
        let uploadStarted: (() => void) | undefined;
        const uploadStartedPromise = new Promise<void>((resolve) => {
            uploadStarted = resolve;
        });
        const upload = () =>
            manager.withUploadTracking(
                "local-id",
                () =>
                    new Promise<void>((resolve) => {
                        uploadCount += 1;
                        uploadStarted?.();
                        finishUpload = resolve;
                    })
            );

        const firstUpload = upload();
        await uploadStartedPromise;
        const secondUpload = upload();
        expect(uploadCount).toBe(1);

        finishUpload?.();
        await Promise.all([firstUpload, secondUpload]);
        expect(uploadCount).toBe(1);
        await expect(store.get("local-id")).resolves.toMatchObject({
            id: "local-id",
            state: "persisted",
        });
    });

    it("uses store upload locks when available", async () => {
        const store = createInMemoryBlobStore("test");
        const lockedIds: string[] = [];
        store.withUploadLock = async (id, callback) => {
            lockedIds.push(id);
            return callback();
        };
        const manager = createBlobManager({
            store,
            remote: {
                metadata: (id) => Promise.resolve({ id, size: 0, type: "", name: "" }),
                blob: () => Promise.reject(new Error("unexpected remote read")),
            },
        });
        await manager.stage("local-id", new Blob(["hello"]));

        await manager.withUploadTracking("local-id", () => Promise.resolve());

        expect(lockedIds).toEqual(["local-id"]);
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
