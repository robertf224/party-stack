import type { BlobRef } from "../types.js";

export interface BlobEvictionCandidate {
    ref: BlobRef;
    retained: boolean;
    releasedAt?: number;
}

export interface BlobEvictionContext {
    now: number;
    cacheMaxAgeMs?: number;
    maxCacheBytes?: number;
}

export type BlobEvictionStrategy = (
    candidates: BlobEvictionCandidate[],
    context: BlobEvictionContext
) => string[];
