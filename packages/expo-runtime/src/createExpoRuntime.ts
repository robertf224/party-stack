import { SingleProcessCoordination } from "@party-stack/coordination";
import { defineRuntime } from "@party-stack/runtime";
import {
    createExpoSQLitePersistence,
    type ExpoSQLiteDatabaseLike,
} from "@tanstack/expo-db-sqlite-persistence";
import { deleteDatabaseAsync, openDatabaseAsync } from "expo-sqlite";
import { createExpoBrowserAuthentication } from "./createExpoBrowserAuthentication.js";
import { ExpoFileSystemBlobBytesStore } from "./ExpoFileSystemBlobBytesStore.js";
import { ExpoNetworkConnectivity } from "./ExpoNetworkConnectivity.js";
import { ExpoSecretStore } from "./ExpoSecretStore.js";

export const createExpoRuntime = defineRuntime(async (
    owner,
    namespace
) => {
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
    const blobBytes = new ExpoFileSystemBlobBytesStore({
        directoryName: `${name}:blobs`,
    });
    return {
        owner,
        namespace,
        blobBytes,
        browserAuthentication:
            createExpoBrowserAuthentication(),
        secrets: new ExpoSecretStore(`${name}:secrets`),
        connectivity,
        coordination,
        persistence,
        destroy: async () => {
            await Promise.all([
                deleteDatabaseAsync(`${name}.db`),
                blobBytes.clear(),
            ]);
        },
        cleanup: async () => {
            await coordination.close();
            connectivity.close();
            await database.closeAsync();
        },
    };
});
