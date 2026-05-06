import type {
    BlobEvictionCandidate,
    BlobEvictionContext,
} from "./types.js";

export function defaultEvictionStrategy(
    candidates: BlobEvictionCandidate[],
    context: BlobEvictionContext
): string[] {
    const unretained = candidates.filter((candidate) => !candidate.retained);
    const released = unretained.filter((candidate) => candidate.releasedAt !== undefined);
    const expired = context.cacheMaxAgeMs
        ? unretained.filter(
              (candidate) =>
                  candidate.ref.state === "cached" &&
                  context.now - (candidate.ref.lastAccessedAt ?? candidate.ref.updatedAt) >=
                      context.cacheMaxAgeMs!
          )
        : [];
    const selected = new Map(
        [...released, ...expired].map((candidate) => [candidate.ref.id, candidate])
    );

    if (context.maxCacheBytes !== undefined) {
        const sorted = unretained
            .filter((candidate) => candidate.ref.state === "cached")
            .sort((left, right) => {
                const leftAccessed = left.ref.lastAccessedAt ?? left.ref.updatedAt;
                const rightAccessed = right.ref.lastAccessedAt ?? right.ref.updatedAt;
                return leftAccessed - rightAccessed || right.ref.size - left.ref.size;
            });
        let totalSize = sorted.reduce((total, candidate) => total + candidate.ref.size, 0);
        for (const candidate of sorted) {
            if (totalSize <= context.maxCacheBytes) {
                break;
            }
            selected.set(candidate.ref.id, candidate);
            totalSize -= candidate.ref.size;
        }
    }

    return Array.from(selected.keys());
}
