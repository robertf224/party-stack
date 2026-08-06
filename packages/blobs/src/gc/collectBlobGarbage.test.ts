import {
    MemoryBlobBytesStore,
    SingleProcessCoordination,
} from "@party-stack/runtime";
import { describe, expect, it, vi } from "vitest";
import { createBlobStore } from "../store/createBlobStore.js";
import {
    BLOB_GC_BATCH_SIZE,
    BLOB_GC_SIZE_UNIT_BYTES,
    collectBlobGarbage,
} from "./collectBlobGarbage.js";
import type { BlobMetadataRecord, BlobRef } from "../types.js";

type TestBlobRecord = BlobMetadataRecord & BlobRef;

function ref(id: string, overrides: Partial<TestBlobRecord> = {}): TestBlobRecord {
    return {
        id,
        type: "application/octet-stream",
        size: 1,
        state: "cached",
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    };
}

function setup(refs: TestBlobRecord[]) {
    const blobBytes = new MemoryBlobBytesStore(
        new Map(
            refs.map(({ id }) => [
                id,
                new Blob([id]),
            ])
        )
    );
    const coordination = new SingleProcessCoordination({
        scope: `blob-gc-${crypto.randomUUID()}`,
    });
    const store = createBlobStore({
        runtime: {
            owner: "user-1",
            namespace: "ontology-1",
            blobBytes,
            coordination,
        },
    });
    return { blobBytes, coordination, store };
}

async function insertRefs(
    store: ReturnType<typeof createBlobStore>,
    refs: TestBlobRecord[]
): Promise<void> {
    for (const value of refs) {
        await store.collection.insert(value, {
            optimistic: false,
        }).isPersisted.promise;
    }
}

describe("collectBlobGarbage", () => {
    it("purges completed remote-backed refs older than the cutoff", async () => {
        const refs = [
            ref("expired", { updatedAt: 10 }),
            ref("persisted", {
                state: "persisted",
                remoteId: "remote-persisted",
                updatedAt: 10,
            }),
            ref("recent", { updatedAt: 100 }),
            ref("staged", {
                state: "staged",
                updatedAt: 10,
            }),
            ref("failed", {
                updatedAt: 10,
                operation: {
                    kind: "cache",
                    status: "failed",
                    operationId: "failed-cache",
                    error: "disk full",
                },
            }),
        ];
        const { blobBytes, coordination, store } =
            setup(refs);
        try {
            await insertRefs(store, refs);
            await collectBlobGarbage(store, {
                cutoff: 100,
                now: 200,
            });

            await expect(
                store.find("expired")
            ).resolves.toBeUndefined();
            await expect(
                store.find("persisted")
            ).resolves.toBeUndefined();
            await expect(
                blobBytes.read("expired")
            ).rejects.toThrow("not found");
            await expect(
                blobBytes.read("persisted")
            ).rejects.toThrow("not found");
            for (const id of [
                "recent",
                "staged",
                "failed",
            ]) {
                await expect(
                    store.find(id)
                ).resolves.toBeDefined();
            }
        } finally {
            await store.cleanup();
            await coordination.close();
        }
    });

    it("drains bounded batches in age-and-size score order", async () => {
        const day = 24 * 60 * 60 * 1_000;
        const now = 2 * day;
        const refs = [
            ...Array.from(
                { length: BLOB_GC_BATCH_SIZE - 1 },
                (_, index) =>
                    ref(`filler-${index}`, {
                        size:
                            100 *
                            BLOB_GC_SIZE_UNIT_BYTES,
                        updatedAt: 0,
                    })
            ),
            ref("large-day-old", {
                size: 10 * BLOB_GC_SIZE_UNIT_BYTES,
                updatedAt: day,
            }),
            ref("tiny-two-days-old", {
                size: 1024,
                updatedAt: 0,
            }),
        ];
        const { coordination, store } = setup(refs);
        try {
            await insertRefs(store, refs);
            const purged: string[] = [];
            const purge = store.purge.bind(store);
            vi.spyOn(store, "purge").mockImplementation(
                async (id, options) => {
                    purged.push(id);
                    await purge(id, options);
                }
            );
            await collectBlobGarbage(store, {
                cutoff: now,
                now,
            });

            expect(
                purged.slice(0, BLOB_GC_BATCH_SIZE)
            ).toContain("large-day-old");
            expect(
                purged.slice(0, BLOB_GC_BATCH_SIZE)
            ).not.toContain("tiny-two-days-old");
            expect(purged).toHaveLength(
                BLOB_GC_BATCH_SIZE + 1
            );
            await expect(
                store.find("large-day-old")
            ).resolves.toBeUndefined();
            await expect(
                store.find("tiny-two-days-old")
            ).resolves.toBeUndefined();
        } finally {
            await store.cleanup();
            await coordination.close();
        }
    });
});
