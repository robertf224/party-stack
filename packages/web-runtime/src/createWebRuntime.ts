import { LockBroadcastCoordination } from "@party-stack/coordination";
import { IndexedDBPersistenceAdapter } from "@party-stack/db-indexeddb-persistence";
import type { RuntimeAdapter } from "@party-stack/runtime";
import { NavigatorNetworkConnectivity } from "./NavigatorNetworkConnectivity.js";
import { OPFSBlobBytesStore } from "./OPFSBlobBytesStore.js";

export function createWebRuntime(owner: string, namespace: string): RuntimeAdapter {
    const name = `party-stack:${owner}:${namespace}`;
    const persistence = new IndexedDBPersistenceAdapter({
        databaseName: name,
    });
    const connectivity = NavigatorNetworkConnectivity.create();
    const coordination = new LockBroadcastCoordination({
        scope: name,
    });
    return {
        owner,
        namespace,
        blobBytes: new OPFSBlobBytesStore({
            directoryName: `${name}:blobs`,
        }),
        coordination,
        connectivity,
        persistence,
        cleanup: async () => {
            await coordination.close();
            await connectivity.close();
            persistence.close();
        },
    };
}
