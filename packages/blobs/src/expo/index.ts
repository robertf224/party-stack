import { createBlobStore } from "../store/createBlobStore.js";
import { ExpoFileSystemBlobBytesAdapter } from "./ExpoFileSystemBlobBytesAdapter.js";
import { ExpoSQLiteBlobMetadataAdapter } from "./ExpoSQLiteBlobMetadataAdapter.js";
import type { BlobStore } from "../types.js";

export interface CreateExpoBlobStoreOptions {
    owner: string;
    namespace: string;
}

export function createExpoBlobStore(opts: CreateExpoBlobStoreOptions): BlobStore {
    return createBlobStore({
        bytes: new ExpoFileSystemBlobBytesAdapter({
            directoryName: `party-stack:${opts.owner}:${opts.namespace}:blobs`,
        }),
        metadata: new ExpoSQLiteBlobMetadataAdapter({
            databaseName: `${opts.owner}:${opts.namespace}.db`,
            tableName: "blobs",
        }),
    });
}
