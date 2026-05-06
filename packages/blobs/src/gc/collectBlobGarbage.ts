import type { BlobStore } from "../types.js";
import type { BlobEvictionCandidate, BlobEvictionStrategy } from "./types.js";

export interface CollectBlobGarbageOptions {
    store: Pick<BlobStore, "list" | "purge">;
    retainCounts: ReadonlyMap<string, number>;
    releaseBuffer: Map<string, number>;
    evictionStrategy: BlobEvictionStrategy;
    now: number;
    cacheMaxAgeMs?: number;
    maxCacheBytes?: number;
}

export async function collectBlobGarbage(opts: CollectBlobGarbageOptions): Promise<void> {
    const refs = await opts.store.list();
    const candidates = refs
        .filter((ref) => ref.state === "cached" || ref.state === "persisted")
        .map(
            (ref): BlobEvictionCandidate => ({
                ref,
                retained: (opts.retainCounts.get(ref.id) ?? 0) > 0,
                releasedAt: opts.releaseBuffer.get(ref.id),
            })
        );
    const ids = opts.evictionStrategy(candidates, {
        now: opts.now,
        cacheMaxAgeMs: opts.cacheMaxAgeMs,
        maxCacheBytes: opts.maxCacheBytes,
    });
    await Promise.all(ids.map((id) => opts.store.purge(id)));
    for (const id of ids) {
        opts.releaseBuffer.delete(id);
    }
}
