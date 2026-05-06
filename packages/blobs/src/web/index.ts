import { createBlobStore } from "../store/createBlobStore.js";
import {
    IndexedDBBlobMetadataAdapter,
    type IndexedDBBlobMetadataAdapterOptions,
} from "./IndexedDBBlobMetadataAdapter.js";
import { OPFSBlobBytesAdapter, type OPFSBlobBytesAdapterOptions } from "./OPFSBlobBytesAdapter.js";
import type { BlobBytesAdapter, BlobMetadataAdapter, BlobStore } from "../types.js";

export interface CreateWebBlobStoreOptions {
    now?: () => number;
}

function blobStorageName(name: string): string {
    return `blobs-${name}`;
}

export function createOPFSBlobBytesAdapter(name: string): BlobBytesAdapter {
    return new OPFSBlobBytesAdapter({
        directoryName: encodeURIComponent(blobStorageName(name)),
    });
}

export function createIndexedDBBlobMetadataAdapter(name: string): BlobMetadataAdapter {
    return new IndexedDBBlobMetadataAdapter({
        databaseName: blobStorageName(name),
    });
}

export function createWebBlobStore(name: string, opts: CreateWebBlobStoreOptions = {}): BlobStore {
    return createBlobStore({
        name,
        bytes: createOPFSBlobBytesAdapter,
        metadata: createIndexedDBBlobMetadataAdapter,
        now: opts.now,
    });
}

export { IndexedDBBlobMetadataAdapter, type IndexedDBBlobMetadataAdapterOptions };
export { OPFSBlobBytesAdapter, type OPFSBlobBytesAdapterOptions };
