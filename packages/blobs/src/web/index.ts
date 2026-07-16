import { createBlobStore } from "../store/createBlobStore.js";
import { IndexedDBBlobMetadataAdapter } from "./IndexedDBBlobMetadataAdapter.js";
import { OPFSBlobBytesAdapter } from "./OPFSBlobBytesAdapter.js";
import type { BlobStore } from "../types.js";

export interface CreateWebBlobStoreOptions {
    owner: string;
    namespace: string;
}

function createWebUploadLock(owner: string, namespace: string): BlobStore["withUploadLock"] | undefined {
    if (!("locks" in navigator)) {
        return undefined;
    }
    return (id, callback) => navigator.locks.request(`${owner}:${namespace}:${id}:upload`, callback);
}

export function createWebBlobStore(opts: CreateWebBlobStoreOptions): BlobStore {
    return createBlobStore({
        bytes: new OPFSBlobBytesAdapter({
            directoryName: `party-stack:${opts.owner}:${opts.namespace}:blobs`,
        }),
        metadata: new IndexedDBBlobMetadataAdapter({
            databaseName: `party-stack:${opts.owner}:${opts.namespace}`,
            storeName: "blobs",
        }),
        withUploadLock: createWebUploadLock(opts.owner, opts.namespace),
    });
}
