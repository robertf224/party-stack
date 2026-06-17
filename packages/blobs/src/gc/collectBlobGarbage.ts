import type { BlobEvictionCandidate, BlobEvictionStrategy } from "./types.js";
import type { BlobRetentionProvider, BlobState, BlobStore } from "../types.js";

export interface CollectBlobGarbageOptions {
    store: Pick<BlobStore, "list" | "purge">;
    evictionStrategy: BlobEvictionStrategy;
    now: number;
    cacheMaxAgeMs?: number;
    maxCacheBytes?: number;
    retentionProviders?: BlobRetentionProvider[];
}

const collectableStates = new Set<BlobState>(["staged", "persisted", "cached", "failed"]);

export async function collectBlobGarbage(opts: CollectBlobGarbageOptions): Promise<void> {
    const refs = await opts.store.list();
    const retainedIds = new Set(
        (
            await Promise.all(
                (opts.retentionProviders ?? []).map((provider) => Promise.resolve(provider()))
            )
        ).flatMap((ids) => [...ids])
    );
    const candidates = refs
        .filter((ref) => collectableStates.has(ref.state))
        .map(
            (ref): BlobEvictionCandidate => ({
                ref,
                retained: retainedIds.has(ref.id) || (ref.remoteId !== undefined && retainedIds.has(ref.remoteId)),
            })
        );
    const ids = opts.evictionStrategy(candidates, {
        now: opts.now,
        cacheMaxAgeMs: opts.cacheMaxAgeMs,
        maxCacheBytes: opts.maxCacheBytes,
    });
    await Promise.all(ids.map((id) => opts.store.purge(id)));
}
