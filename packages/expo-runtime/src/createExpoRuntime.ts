import { SingleProcessCoordination } from "@party-stack/coordination";
import {
    createExpoSQLitePersistence,
    type ExpoSQLiteDatabaseLike,
} from "@tanstack/expo-db-sqlite-persistence";
import { openDatabaseAsync } from "expo-sqlite";
import type { RuntimeAdapter } from "@party-stack/runtime";
import { ExpoFileSystemBlobBytesStore } from "./ExpoFileSystemBlobBytesStore.js";
import { ExpoNetworkConnectivity } from "./ExpoNetworkConnectivity.js";

export async function createExpoRuntime(
    owner: string,
    namespace: string
): Promise<RuntimeAdapter> {
    const name = `party-stack:${owner}:${namespace}`;
    const [database, connectivity] = await Promise.all([
        openDatabaseAsync(`${name}.db`),
        ExpoNetworkConnectivity.create(),
    ]);
    const { adapter: persistence } = createExpoSQLitePersistence({
        database: database as unknown as ExpoSQLiteDatabaseLike,
    });
    const coordination =
        new SingleProcessCoordination({
            scope: name,
        });
    return {
        owner,
        namespace,
        blobBytes: new ExpoFileSystemBlobBytesStore({
            directoryName: `${name}:blobs`,
        }),
        connectivity,
        coordination,
        persistence,
        cleanup: async () => {
            await coordination.close();
            connectivity.close();
            await database.closeAsync();
        },
    };
}
