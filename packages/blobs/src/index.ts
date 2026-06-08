import { invariant } from "@bobbyfidz/panic";
import { collectBlobGarbage, defaultEvictionStrategy } from "./gc/index.js";
import type { BlobEvictionStrategy } from "./gc/index.js";
import type {
    BlobManager,
    BlobManagerOptions,
    BlobRemoteMetadata,
    BlobRef,
} from "./types.js";

export * from "./gc/index.js";
export {
    createInMemoryBlobBytesAdapter,
    createInMemoryBlobMetadataAdapter,
    createInMemoryBlobStore,
} from "./memory/index.js";
export type { CreateInMemoryBlobStoreOptions } from "./memory/index.js";
export type {
    BlobManager,
    BlobManagerOptions,
    BlobBytesAdapterProvider,
    BlobMetadataAdapterProvider,
    BlobRef,
    BlobRemoteMetadata,
    BlobRemoteSource,
    BlobRetentionProvider,
    BlobState,
    BlobStore,
    BlobStoreProvider,
} from "./types.js";

function toMetadata(ref: BlobRef): BlobRemoteMetadata {
    return {
        id: ref.id,
        size: ref.size,
        type: ref.type,
        name: ref.name ?? "",
    };
}

export function createBlobManager(opts: BlobManagerOptions): BlobManager {
    const now = () => opts.now?.() ?? Date.now();
    const leaseCounts = new Map<string, number>();
    const releaseBuffer = new Map<string, number>();
    const uploads = new Map<string, Promise<void>>();
    const gcReleaseBufferSize = opts.gcReleaseBufferSize ?? 10;
    const evictionStrategy: BlobEvictionStrategy = opts.evictionStrategy ?? defaultEvictionStrategy;
    let gcScheduled = false;
    const reconcilePromise = opts.store.reconcile();

    const scheduleGC = () => {
        if (gcScheduled) {
            return;
        }
        gcScheduled = true;
        const run = () => {
            gcScheduled = false;
            void collectGarbage();
        };
        if (opts.gcScheduler) {
            opts.gcScheduler(run);
        } else {
            queueMicrotask(run);
        }
    };

    const collectGarbage = () =>
        collectBlobGarbage({
            store: opts.store,
            leaseCounts,
            releaseBuffer,
            evictionStrategy,
            now: now(),
            cacheMaxAgeMs: opts.cacheMaxAgeMs,
            maxCacheBytes: opts.maxCacheBytes,
            retentionProviders: opts.retentionProviders,
        });

    const addLease = (id: string) => {
        leaseCounts.set(id, (leaseCounts.get(id) ?? 0) + 1);
        releaseBuffer.delete(id);
    };

    const removeLease = (id: string) => {
        const count = leaseCounts.get(id) ?? 0;
        if (count <= 1) {
            leaseCounts.delete(id);
            releaseBuffer.set(id, now());
            if (releaseBuffer.size > gcReleaseBufferSize) {
                scheduleGC();
            }
            return;
        }
        leaseCounts.set(id, count - 1);
    };

    return {
        async stage(id, blob) {
            await reconcilePromise;
            return opts.store.stage(id, blob);
        },

        async metadata(id, readOptions) {
            await reconcilePromise;
            const ref = await opts.store.get(id);
            if (ref) {
                return toMetadata(ref);
            }
            return opts.remote.metadata(id, readOptions);
        },

        async blob(id, readOptions) {
            await reconcilePromise;
            try {
                return await opts.store.read(id);
            } catch (error) {
                void error;
            }

            const [blob, metadata] = await Promise.all([
                opts.remote.blob(id, readOptions),
                opts.remote.metadata(id, readOptions),
            ]);
            await opts.store.cache(id, new File([blob], metadata.name, { type: blob.type }));
            scheduleGC();
            return blob;
        },

        withUploadTracking(id: string, callback: (blob: Blob) => Promise<void>): Promise<void> {
            const run = async (): Promise<void> => {
                await reconcilePromise;
                const existingRef = await opts.store.get(id);
                invariant(existingRef, `Blob metadata not found for "${id}".`);
                if (existingRef.state === "persisted" || existingRef.state === "cached") {
                    return;
                }

                try {
                    const blob = await opts.store.read(id);
                    await opts.store.markUploading(id);
                    await callback(blob);
                    await opts.store.markPersisted(id);
                } catch (error) {
                    await opts.store.markFailed(id, error);
                    throw error;
                }
            };

            const withLock = opts.store.withUploadLock;
            if (withLock) {
                return withLock(id, run);
            }

            const existingUpload = uploads.get(id);
            if (existingUpload) {
                return existingUpload;
            }

            const upload = run().finally(() => {
                uploads.delete(id);
            });
            uploads.set(id, upload);
            return upload;
        },

        lease(id) {
            addLease(id);
            return () => {
                removeLease(id);
            };
        },
    };
}
