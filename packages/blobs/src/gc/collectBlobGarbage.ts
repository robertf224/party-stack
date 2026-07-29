import {
    add,
    and,
    coalesce,
    divide,
    eq,
    isUndefined,
    lt,
    multiply,
    or,
    queryOnce,
    subtract,
} from "@tanstack/db";
import type { BlobStore } from "../store/createBlobStore.js";

export interface CollectBlobGarbageOptions {
    cutoff: number;
    now: number;
    signal?: AbortSignal;
}

export const BLOB_GC_BATCH_SIZE = 50;
export const BLOB_GC_SIZE_UNIT_BYTES = 1024 * 1024;
const BLOB_GC_ESTIMATED_ENTRY_OVERHEAD_BYTES = 512;
const MILLISECONDS_PER_SECOND = 1000;

function throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
        ? signal.reason
        : new Error("Blob garbage collection was aborted.");
}

export async function collectBlobGarbage(
    store: BlobStore,
    opts: CollectBlobGarbageOptions
): Promise<void> {
    throwIfAborted(opts.signal);
    await store.ready;
    // Drain every eligible blob in bounded query pages. Waiting for another
    // wake after one full page would strand older candidates when a burst of
    // cache writes coalesces into a single wake.
    while (true) {
        throwIfAborted(opts.signal);
        const refs = await queryOnce((query) =>
            query
                .from({ blob: store.collection })
                .where(({ blob }) =>
                    and(
                        or(
                            eq(blob.state, "cached"),
                            eq(blob.state, "persisted")
                        ),
                        isUndefined(blob.operation),
                        lt(
                            coalesce(
                                blob.lastAccessedAt,
                                blob.updatedAt
                            ),
                            opts.cutoff
                        )
                    )
                )
                .orderBy(
                    ({ blob }) =>
                        // Chromium's Simple Cache ranks eviction candidates by
                        // `time_since_last_used * (entry_size + 512)`. The
                        // estimated 512-byte per-entry overhead also keeps tiny
                        // entries from being distinguished by insignificant
                        // size differences:
                        // https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/disk_cache/simple/simple_index.cc#425
                        //
                        // Preserve that ordering while normalizing age to
                        // seconds and size to MiB so the intermediate
                        // JavaScript numbers remain smaller. Higher scores are
                        // purged first.
                        multiply(
                            divide(
                                subtract(
                                    opts.now,
                                    coalesce(
                                        blob.lastAccessedAt,
                                        blob.updatedAt
                                    )
                                ),
                                MILLISECONDS_PER_SECOND
                            ),
                            divide(
                                add(
                                    blob.size,
                                    BLOB_GC_ESTIMATED_ENTRY_OVERHEAD_BYTES
                                ),
                                BLOB_GC_SIZE_UNIT_BYTES
                            )
                        ),
                    "desc"
                )
                .select(({ blob }) => ({
                    id: blob.id,
                }))
                .limit(BLOB_GC_BATCH_SIZE)
        );
        for (const { id } of refs) {
            throwIfAborted(opts.signal);
            await store.purge(id, {
                signal: opts.signal,
            });
        }
        if (refs.length < BLOB_GC_BATCH_SIZE) return;
    }
}
