import {
    createExpoSQLitePersistence,
    type ExpoSQLiteDatabaseLike,
} from "@tanstack/expo-db-sqlite-persistence";
import { openDatabaseAsync } from "expo-sqlite";
import { ExpoFileSystemBlobBytesStore } from "../expo/ExpoFileSystemBlobBytesStore.js";
import type { RuntimeServices } from "../types.js";

export async function expoOffline(owner: string, namespace: string): Promise<RuntimeServices> {
    const database = await openDatabaseAsync(`party-stack:${owner}:${namespace}.db`);

    return {
        blobBytes: new ExpoFileSystemBlobBytesStore({
            directoryName: `party-stack:${owner}:${namespace}:blobs`,
        }),
        persistence: {
            adapter: createExpoSQLitePersistence({
                database: database as unknown as ExpoSQLiteDatabaseLike,
            }).adapter,
            persistObjects: true,
        },
        cleanup: async () => {
            await database.closeAsync();
        },
    };
}
