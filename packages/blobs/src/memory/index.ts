import { createBlobStore } from "../store/createBlobStore.js";
import { InMemoryBlobBytesAdapter, InMemoryBlobMetadataAdapter } from "./adapters.js";
import type { BlobBytesAdapter, BlobMetadataAdapter, BlobStore } from "../types.js";

export interface CreateInMemoryBlobStoreOptions {
    now?: () => number;
}

export function createInMemoryBlobBytesAdapter(): BlobBytesAdapter {
    return new InMemoryBlobBytesAdapter();
}

export function createInMemoryBlobMetadataAdapter(): BlobMetadataAdapter {
    return new InMemoryBlobMetadataAdapter();
}

export function createInMemoryBlobStore(
    name: string,
    opts: CreateInMemoryBlobStoreOptions = {}
): BlobStore {
    return createBlobStore({
        name,
        bytes: createInMemoryBlobBytesAdapter,
        metadata: createInMemoryBlobMetadataAdapter,
        now: opts.now,
    });
}
