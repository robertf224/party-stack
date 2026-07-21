import { IndexedDBPersistenceAdapter } from "../web/IndexedDBPersistenceAdapter.js";
import { OPFSBlobBytesStore } from "../web/OPFSBlobBytesStore.js";
import type { RuntimeServices } from "../types.js";

export function webOnline(owner: string, namespace: string): RuntimeServices {
    const persistence = new IndexedDBPersistenceAdapter({
        databaseName: `party-stack:${owner}:${namespace}`,
    });

    return {
        blobBytes: new OPFSBlobBytesStore({
            directoryName: `party-stack:${owner}:${namespace}:blobs`,
        }),
        locks: navigator.locks,
        persistence: {
            adapter: persistence,
            persistObjects: false,
        },
        cleanup: () => persistence.close(),
    };
}
