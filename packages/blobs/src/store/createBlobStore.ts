import type {
    BlobBytesAdapterProvider,
    BlobMetadataAdapterProvider,
    BlobRef,
    BlobStore,
} from "../types.js";

export interface CreateBlobStoreOptions {
    name: string;
    bytes: BlobBytesAdapterProvider;
    metadata: BlobMetadataAdapterProvider;
    now?: () => number;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function blobName(blob: Blob): string | undefined {
    return "name" in blob && typeof blob.name === "string" ? blob.name : undefined;
}

function createBlobRef(id: string, blob: Blob | File, now: number): BlobRef {
    return {
        id,
        type: blob.type,
        size: blob.size,
        name: blobName(blob),
        state: "staging",
        createdAt: now,
        updatedAt: now,
    };
}

export function createBlobStore(opts: CreateBlobStoreOptions): BlobStore {
    const now = () => opts.now?.() ?? Date.now();
    const bytes = opts.bytes(opts.name);
    const metadata = opts.metadata(opts.name);

    const updateRef = async (
        id: string,
        update: (ref: BlobRef, timestamp: number) => BlobRef
    ): Promise<BlobRef> => {
        const existing = await metadata.get(id);
        if (!existing) {
            throw new Error(`Blob metadata not found for "${id}".`);
        }
        const updated = update(existing, now());
        await metadata.put(updated);
        return updated;
    };

    const touch = async (id: string): Promise<BlobRef | undefined> => {
        const ref = await metadata.get(id);
        if (!ref) {
            return undefined;
        }
        const timestamp = now();
        const updated = {
            ...ref,
            lastAccessedAt: timestamp,
            updatedAt: timestamp,
        };
        await metadata.put(updated);
        return updated;
    };

    return {
        async stage(id, blob) {
            const timestamp = now();
            const ref = createBlobRef(id, blob, timestamp);
            await metadata.put(ref);
            try {
                await bytes.write(ref.id, blob);
                const stagedRef = { ...ref, state: "staged" as const, updatedAt: now() };
                await metadata.put(stagedRef);
                return stagedRef;
            } catch (error) {
                const failedRef = {
                    ...ref,
                    state: "failed" as const,
                    updatedAt: now(),
                    error: errorMessage(error),
                };
                await metadata.put(failedRef);
                throw error;
            }
        },

        async cache(id, blob) {
            const timestamp = now();
            const existing = await metadata.get(id);
            const cachedRef: BlobRef = {
                id,
                type: blob.type,
                size: blob.size,
                name: blobName(blob),
                state: "cached",
                createdAt: existing?.createdAt ?? timestamp,
                updatedAt: timestamp,
                lastAccessedAt: timestamp,
            };
            await bytes.write(id, blob);
            await metadata.put(cachedRef);
            return cachedRef;
        },

        get(id) {
            return touch(id);
        },

        async read(id) {
            const blob = await bytes.read(id);
            await touch(id);
            return blob;
        },

        list(listOpts) {
            return metadata.list(listOpts);
        },

        markUploading(id) {
            return updateRef(id, (ref, timestamp) => ({
                ...ref,
                state: "uploading",
                updatedAt: timestamp,
                error: undefined,
            }));
        },

        markPersisted(id) {
            return updateRef(id, (ref, timestamp) => ({
                ...ref,
                state: "persisted",
                updatedAt: timestamp,
                error: undefined,
            }));
        },

        markFailed(id, error) {
            return updateRef(id, (ref, timestamp) => ({
                ...ref,
                state: "failed",
                updatedAt: timestamp,
                error: error === undefined ? undefined : errorMessage(error),
            }));
        },

        async purge(id) {
            await Promise.all([metadata.delete(id), bytes.delete(id)]);
        },

        async reconcile() {
            const refs = await metadata.list();
            const refIds = new Set(refs.map((ref) => ref.id));
            await Promise.all(
                refs
                    .filter((ref) => ref.state === "staging")
                    .map(async (ref) => {
                        try {
                            await bytes.read(ref.id);
                            await metadata.put({
                                ...ref,
                                state: "staged",
                                updatedAt: now(),
                            });
                        } catch {
                            await metadata.delete(ref.id);
                        }
                    })
            );

            const byteIds = await bytes.list?.();
            if (!byteIds) {
                return;
            }
            await Promise.all(
                byteIds.filter((id) => !refIds.has(id)).map((id) => bytes.delete(id))
            );
        },
    };
}
