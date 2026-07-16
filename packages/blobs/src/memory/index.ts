import { createBlobStore } from "../store/createBlobStore.js";
import { InMemoryBlobBytesAdapter } from "./InMemoryBlobBytesAdapter.js";
import { InMemoryBlobMetadataAdapter } from "./InMemoryBlobMetadataAdapter.js";
import type { BlobStore } from "../types.js";

export interface CreateInMemoryBlobStoreOptions {
    now?: () => number;
}

export function createInMemoryBlobStore(opts: CreateInMemoryBlobStoreOptions = {}): BlobStore {
    return createBlobStore({
        bytes: new InMemoryBlobBytesAdapter(),
        metadata: new InMemoryBlobMetadataAdapter(),
        now: opts.now,
    });
}
