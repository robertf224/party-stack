import { LockBroadcastCoordination } from "@party-stack/coordination";
import { IndexedDBPersistenceAdapter } from "@party-stack/db-indexeddb-persistence";
import { defineRuntime } from "@party-stack/runtime";
import {
    createWebBrowserAuthentication,
} from "./createWebBrowserAuthentication.js";
import { NavigatorNetworkConnectivity } from "./NavigatorNetworkConnectivity.js";
import { OPFSBlobBytesStore } from "./OPFSBlobBytesStore.js";

function deleteIndexedDB(name: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () =>
            reject(
                new Error(`IndexedDB database "${name}" could not be deleted.`, {
                    cause: request.error,
                })
            );
        request.onblocked = () =>
            reject(new Error(`IndexedDB database "${name}" could not be deleted because it is open.`));
    });
}

export const createWebRuntime = defineRuntime((
    owner,
    namespace
) => {
    const name = `party-stack:${owner}:${namespace}`;
    const persistence = new IndexedDBPersistenceAdapter({
        databaseName: name,
    });
    const connectivity = NavigatorNetworkConnectivity.create();
    const coordination = new LockBroadcastCoordination({
        scope: name,
    });
    const blobBytes = new OPFSBlobBytesStore({
        directoryName: `${name}:blobs`,
    });
    return {
        owner,
        namespace,
        blobBytes,
        coordination,
        connectivity,
        browserAuthentication:
            createWebBrowserAuthentication(),
        persistence,
        destroy: async () => {
            await Promise.all([
                deleteIndexedDB(name),
                blobBytes.clear(),
            ]);
        },
        cleanup: async () => {
            await coordination.close();
            await connectivity.close();
            persistence.close();
        },
    };
});
