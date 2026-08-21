import {
    CoordinationTaskRejectedError,
    MemoryBlobBytesStore,
    SingleProcessCoordination,
    type Coordination,
    type CoordinationService,
} from "@party-stack/runtime";
import { eq, queryOnce } from "@tanstack/db";
import { describe, expect, it } from "vitest";
import {
    BlobBytesUnavailableError,
    createBlobStore,
} from "./createBlobStore.js";
import type { BlobMetadataRecord, BlobRef } from "../types.js";

type TestBlobRecord = BlobMetadataRecord & BlobRef;

class TestBlobBytesStore extends MemoryBlobBytesStore {
    writeError?: Error;
    deleteError?: Error;
    writePartialBytes = false;

    override write(id: string, blob: Blob): Promise<void> {
        if (!this.writeError) return super.write(id, blob);
        if (this.writePartialBytes) this.blobs.set(id, blob);
        return Promise.reject(this.writeError);
    }

    override delete(id: string): Promise<void> {
        return this.deleteError
            ? Promise.reject(this.deleteError)
            : super.delete(id);
    }
}

async function expectTaskRejection(
    promise: Promise<unknown>,
    code: string
): Promise<void> {
    const error = await promise.then(
        () => undefined,
        (reason: unknown) => reason
    );
    expect(error).toBeInstanceOf(
        CoordinationTaskRejectedError
    );
    if (error instanceof CoordinationTaskRejectedError) {
        expect(error.code).toBe(code);
    }
}

function asClient(
    coordination: Coordination
): Coordination {
    return {
        role: "client",
        service<Service extends CoordinationService>(
            namespace: string
        ) {
            return coordination.service<Service>(namespace);
        },
        close: () => Promise.resolve(),
    };
}

function setup(
    blobs = new Map<string, Blob>()
) {
    const bytes = new TestBlobBytesStore(blobs);
    const coordination = new SingleProcessCoordination({
        scope: "blob-store-test",
    });
    const store = createBlobStore({
        runtime: {
            owner: "user-1",
            namespace: "ontology-1",
            blobBytes: bytes,
            coordination,
        },
    });
    return { bytes, coordination, store };
}

describe("createBlobStore", () => {
    it("ties staged bytes to collection metadata", async () => {
        const { bytes, store } = setup();

        const ref = await store.stage(
            "local-id",
            new File(["hello"], "hello.txt", {
                type: "text/plain",
            })
        );

        expect(ref).toMatchObject({
            id: "local-id",
            name: "hello.txt",
        });
        expect(store.collection.get("local-id")).toMatchObject({
            state: "staged",
            operation: undefined,
        });
        await expect(
            bytes.read("local-id").then((blob) => blob.text())
        ).resolves.toBe("hello");
        await store.cleanup();
    });

    it("caches remote bytes and clears the cache operation", async () => {
        const { store } = setup();

        const ref = await store.cache(
            "remote-id",
            new File(["remote"], "remote.txt", {
                type: "text/plain",
            })
        );

        expect(ref).toMatchObject({
            id: "remote-id",
            name: "remote.txt",
        });
        expect(store.collection.get("remote-id")).toMatchObject({
            state: "cached",
            operation: undefined,
        });
        await expect(
            store.read("remote-id").then((blob) => blob.text())
        ).resolves.toBe("remote");
        await store.cleanup();
    });

    it("queries refs by local id, remote id, and state", async () => {
        const { store } = setup();
        await store.stage("local-id", new Blob(["hello"]));
        await store.bindRemoteId(
            "local-id",
            "remote-id"
        );

        await expect(store.find("remote-id")).resolves.toMatchObject(
            {
                id: "local-id",
                remoteId: "remote-id",
                state: "persisted",
            }
        );
        await expect(
            queryOnce((query) =>
                query
                    .from({ blob: store.collection })
                    .where(({ blob }) =>
                        eq(blob.state, "persisted")
                    )
                    .select(({ blob }) => ({
                        id: blob.id,
                    }))
            )
        ).resolves.toEqual([
            expect.objectContaining({ id: "local-id" }),
        ]);
        await expect(
            store.read("remote-id").then((blob) => blob.text())
        ).resolves.toBe("hello");
        await store.cleanup();
    });

    it("does not let access-time updates revert lifecycle state", async () => {
        const { store } = setup();
        await store.stage("local-id", new Blob(["hello"]));

        await Promise.all([
            store.read("local-id"),
            store.bindRemoteId(
                "local-id",
                "remote-id"
            ),
        ]);

        await expect(store.find("local-id")).resolves.toMatchObject({
            state: "persisted",
        });
        await store.cleanup();
    });

    it("records stage write failures without inventing a stable state", async () => {
        const { bytes, store } = setup();
        bytes.writeError = new Error("disk full");

        await expect(
            store.stage("local-id", new Blob(["partial"]))
        ).rejects.toThrow("disk full");

        const ref = await store.find("local-id");
        expect(ref?.state).toBeUndefined();
        expect(ref?.operation).toMatchObject({
            kind: "stage",
            status: "failed",
            error: "disk full",
        });
        expect(ref?.operation?.operationId).toEqual(
            expect.any(String)
        );
        await store.cleanup();
    });

    it("records cache write failures while preserving persisted state", async () => {
        const { bytes, store } = setup();
        bytes.writeError = new Error("disk full");
        bytes.writePartialBytes = true;

        await expect(
            store.cache("remote-id", new Blob(["partial"]))
        ).rejects.toThrow("disk full");

        await expect(store.find("remote-id")).resolves.toMatchObject({
            state: "persisted",
            operation: {
                kind: "cache",
                status: "failed",
                error: "disk full",
            },
        });
        await expect(store.read("remote-id")).rejects.toBeInstanceOf(
            BlobBytesUnavailableError
        );
        await expect(bytes.read("remote-id")).rejects.toThrow(
            "not found"
        );
        await store.cleanup();
    });

    it("mints operation ids and fences stale write requests", async () => {
        const { bytes, store } = setup();
        const metadata = {
            type: "text/plain",
            size: 5,
            name: "blob.txt",
        };
        const first = await store.beginWrite({
            id: "local-id",
            kind: "stage",
            metadata,
        });
        await expectTaskRejection(
            store.beginWrite({
                id: "local-id",
                kind: "stage",
                metadata,
            }),
            "BLOB_OPERATION_CONFLICT"
        );
        await store.failWrite({
            ...first,
            error: "first write stopped",
        });

        const second = await store.beginWrite({
            id: "local-id",
            kind: "stage",
            metadata,
        });
        expect(second.operationId).not.toBe(
            first.operationId
        );
        await bytes.write(
            second.id,
            new Blob(["fresh"], { type: "text/plain" })
        );

        await expectTaskRejection(
            store.commitWrite(first),
            "BLOB_OPERATION_STALE"
        );
        await expectTaskRejection(
            store.failWrite({
                ...first,
                error: "late failure",
            }),
            "BLOB_OPERATION_STALE"
        );
        await expect(
            bytes.read(second.id).then((blob) => blob.text())
        ).resolves.toBe("fresh");

        await expect(
            store.commitWrite(second)
        ).resolves.toMatchObject({
            id: "local-id",
            size: 5,
            type: "text/plain",
        });
        expect(store.collection.get("local-id")).toMatchObject({
            state: "staged",
            operation: undefined,
        });
        await store.cleanup();
    });

    it("rejects recovery from client-only coordination values", async () => {
        const { bytes, coordination, store } = setup();
        const clientStore = createBlobStore({
            runtime: {
                owner: "user-1",
                namespace: "ontology-1",
                blobBytes: bytes,
                coordination:
                    asClient(coordination),
            },
        });

        await expectTaskRejection(
            clientStore.recoverAsLeader(
                new AbortController().signal
            ),
            "BLOB_RECOVERY_NOT_LEADER"
        );

        await clientStore.cleanup();
        await store.cleanup();
    });

    it("deletes interrupted stage bytes and marks the operation failed", async () => {
        const { bytes, coordination, store } = setup(
            new Map([["local-id", new Blob(["partial"])]])
        );
        const timestamp = Date.now();
        const ref: TestBlobRecord = {
            id: "local-id",
            type: "text/plain",
            size: 7,
            operation: {
                kind: "stage",
                status: "pending",
                operationId: "interrupted-stage",
            },
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        await store.collection.insert(ref, {
            optimistic: false,
        }).isPersisted.promise;

        await coordination.runAsLeader(({ signal }) =>
            store.recoverAsLeader(signal)
        );

        await expect(bytes.read("local-id")).rejects.toThrow("not found");
        const recovered = await store.find("local-id");
        expect(recovered?.state).toBeUndefined();
        expect(recovered?.operation).toMatchObject({
            kind: "stage",
            status: "failed",
        });
        expect(
            recovered?.operation?.status === "failed"
                ? recovered.operation.error
                : undefined
        ).toContain("interrupted before completion");

        await bytes.write(
            "local-id",
            new Blob(["late write"])
        );
        await store.failWrite({
            id: "local-id",
            operationId: "interrupted-stage",
            error: "late writer observed failover",
        });
        await expect(
            bytes.read("local-id")
        ).rejects.toThrow("not found");
        await store.cleanup();
    });

    it("deletes interrupted cache bytes and preserves persisted state", async () => {
        const { bytes, coordination, store } = setup(
            new Map([["remote-id", new Blob(["partial"])]])
        );
        const timestamp = Date.now();
        await store.collection
            .insert(
                {
                    id: "remote-id",
                    type: "text/plain",
                    size: 7,
                    state: "persisted",
                    operation: {
                        kind: "cache",
                        status: "pending",
                        operationId: "interrupted-cache",
                    },
                    createdAt: timestamp,
                    updatedAt: timestamp,
                },
                { optimistic: false }
            )
            .isPersisted.promise;

        await coordination.runAsLeader(({ signal }) =>
            store.recoverAsLeader(signal)
        );

        await expect(bytes.read("remote-id")).rejects.toThrow("not found");
        const recovered = await store.find("remote-id");
        expect(recovered).toMatchObject({
            state: "persisted",
            operation: {
                kind: "cache",
                status: "failed",
            },
        });
        expect(
            recovered?.operation?.status === "failed"
                ? recovered.operation.error
                : undefined
        ).toContain("interrupted before completion");
        await store.cleanup();
    });

    it("finishes an interrupted purge", async () => {
        const { bytes, coordination, store } = setup(
            new Map([["cached-id", new Blob(["cached"])]])
        );
        const timestamp = Date.now();
        await store.collection
            .insert(
                {
                    id: "cached-id",
                    type: "text/plain",
                    size: 6,
                    state: "cached",
                    operation: {
                        kind: "purge",
                        status: "pending",
                        operationId: "interrupted-purge",
                    },
                    createdAt: timestamp,
                    updatedAt: timestamp,
                },
                { optimistic: false }
            )
            .isPersisted.promise;

        await coordination.runAsLeader(({ signal }) =>
            store.recoverAsLeader(signal)
        );

        await expect(store.find("cached-id")).resolves.toBeUndefined();
        await expect(bytes.read("cached-id")).rejects.toThrow("not found");
        await store.cleanup();
    });

    it("leaves stable and already-failed records alone during reconciliation", async () => {
        const { bytes, coordination, store } = setup(
            new Map([
                ["stable", new Blob(["stable"])],
                ["failed", new Blob(["existing"])],
            ])
        );
        const timestamp = Date.now();
        await store.collection
            .insert(
                {
                    id: "stable",
                    type: "text/plain",
                    size: 6,
                    state: "cached",
                    createdAt: timestamp,
                    updatedAt: timestamp,
                },
                { optimistic: false }
            )
            .isPersisted.promise;
        await store.collection
            .insert(
                {
                    id: "failed",
                    type: "text/plain",
                    size: 8,
                    state: "persisted",
                    operation: {
                        kind: "cache",
                        status: "failed",
                        operationId: "failed-cache",
                        error: "previous failure",
                    },
                    createdAt: timestamp,
                    updatedAt: timestamp,
                },
                { optimistic: false }
            )
            .isPersisted.promise;

        await coordination.runAsLeader(({ signal }) =>
            store.recoverAsLeader(signal)
        );

        await expect(
            bytes.read("stable").then((blob) => blob.text())
        ).resolves.toBe("stable");
        await expect(
            bytes.read("failed").then((blob) => blob.text())
        ).resolves.toBe("existing");
        await expect(store.find("failed")).resolves.toMatchObject({
            operation: {
                status: "failed",
                error: "previous failure",
            },
        });
        await store.cleanup();
    });

    it("retains metadata and records purge deletion failures", async () => {
        const { bytes, store } = setup();
        await store.stage("local-id", new Blob(["hello"]));
        bytes.deleteError = new Error("busy");

        await expect(store.purge("local-id")).rejects.toThrow(
            "busy"
        );

        await expect(store.find("local-id")).resolves.toMatchObject({
            state: "staged",
            operation: {
                kind: "purge",
                status: "failed",
                error: "busy",
            },
        });
        await store.cleanup();
    });

    it("distinguishes unavailable bytes from metadata failures", async () => {
        const { store } = setup();
        await store.collection
            .insert({
                id: "missing",
                type: "text/plain",
                size: 5,
                state: "cached",
                createdAt: Date.now(),
                updatedAt: Date.now(),
            })
            .isPersisted.promise;

        await expect(store.read("missing")).rejects.toBeInstanceOf(
            BlobBytesUnavailableError
        );
        await store.cleanup();
    });

    it("settles immediate and repeated cleanup during persistence startup", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => {
            unhandled.push(reason);
        };
        process.on("unhandledRejection", onUnhandled);

        try {
            const { store } = setup();
            await expect(Promise.all([store.ready, store.cleanup()])).resolves.toBeDefined();
            await expect(store.cleanup()).resolves.toBeUndefined();
            expect(store.collection.status).toBe("cleaned-up");
            expect(unhandled).toEqual([]);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });
});
