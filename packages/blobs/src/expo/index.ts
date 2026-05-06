import { createBlobStore } from "../store/createBlobStore.js";
import { ExpoFileSystemBlobBytesAdapter } from "./ExpoFileSystemBlobBytesAdapter.js";
import { ExpoSQLiteBlobMetadataAdapter } from "./ExpoSQLiteBlobMetadataAdapter.js";
import type { BlobBytesAdapter, BlobMetadataAdapter, BlobStore } from "../types.js";

export interface CreateExpoBlobStoreOptions {
    now?: () => number;
}

function blobStorageName(name: string): string {
    return `blobs-${name}`;
}

export function createExpoFileSystemBlobBytesAdapter(name: string): BlobBytesAdapter {
    return new ExpoFileSystemBlobBytesAdapter({
        directoryName: encodeURIComponent(blobStorageName(name)),
    });
}

export function createExpoSQLiteBlobMetadataAdapter(name: string): BlobMetadataAdapter {
    return new ExpoSQLiteBlobMetadataAdapter({
        databaseName: `${encodeURIComponent(blobStorageName(name))}.db`,
    });
}

export function createExpoBlobStore(name: string, opts: CreateExpoBlobStoreOptions = {}): BlobStore {
    return createBlobStore({
        name,
        bytes: createExpoFileSystemBlobBytesAdapter,
        metadata: createExpoSQLiteBlobMetadataAdapter,
        now: opts.now,
    });
}

export {
    ExpoFileSystemBlobBytesAdapter,
    type ExpoFileSystemBlobBytesAdapterOptions,
} from "./ExpoFileSystemBlobBytesAdapter.js";
export {
    ExpoSQLiteBlobMetadataAdapter,
    type ExpoSQLiteBlobMetadataAdapterOptions,
} from "./ExpoSQLiteBlobMetadataAdapter.js";
