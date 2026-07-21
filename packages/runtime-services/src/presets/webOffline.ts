import {
    createBrowserWASQLitePersistence,
    openBrowserWASQLiteOPFSDatabase,
} from "@tanstack/browser-db-sqlite-persistence";
import { OPFSBlobBytesStore } from "../web/OPFSBlobBytesStore.js";
import type { RuntimeServices } from "../types.js";

export async function webOffline(owner: string, namespace: string): Promise<RuntimeServices> {
    const database = await openBrowserWASQLiteOPFSDatabase({
        databaseName: `party-stack:${owner}:${namespace}`,
    });

    return {
        blobBytes: new OPFSBlobBytesStore({
            directoryName: `party-stack:${owner}:${namespace}:blobs`,
        }),
        locks: navigator.locks,
        persistence: {
            adapter: createBrowserWASQLitePersistence({
                database,
            }).adapter,
            persistObjects: true,
        },
        cleanup: async () => {
            await database.close?.();
        },
    };
}
