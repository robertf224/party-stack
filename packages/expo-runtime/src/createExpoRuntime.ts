// SQLite persistence revives Temporal values through the registered global constructors.
import "temporal-polyfill/global";
import { SingleProcessCoordination } from "@party-stack/coordination";
import { defineRuntime } from "@party-stack/runtime";
import { createExpoSQLitePersistence } from "@tanstack/expo-db-sqlite-persistence";
import { deleteDatabaseAsync, openDatabaseAsync } from "expo-sqlite";
import { createExpoBrowserAuthentication } from "./createExpoBrowserAuthentication.js";
import { ExpoFileSystemBlobBytesStore } from "./ExpoFileSystemBlobBytesStore.js";
import { ExpoNetworkConnectivity } from "./ExpoNetworkConnectivity.js";
import { ExpoSecretStore } from "./ExpoSecretStore.js";
import { hashStorageName } from "./hashStorageName.js";
import type { RuntimeAdapter } from "@party-stack/runtime";

export const createExpoRuntime: (owner: string, namespace: string) => Promise<RuntimeAdapter> = defineRuntime(
    async (owner, namespace) => {
        const name = `party-stack:${owner}:${namespace}`;
        const storageName = `party-stack-${await hashStorageName(JSON.stringify([owner, namespace]))}`;
        const [database, connectivity] = await Promise.all([
            openDatabaseAsync(`${storageName}.db`),
            ExpoNetworkConnectivity.create(),
        ]);
        const persistence = createExpoSQLitePersistence({
            database: database,
        });
        const coordination = new SingleProcessCoordination({
            scope: name,
        });
        const blobBytes = new ExpoFileSystemBlobBytesStore({
            directoryName: `${storageName}-blobs`,
        });
        return {
            owner,
            namespace,
            blobBytes,
            browserAuthentication: createExpoBrowserAuthentication(),
            secrets: new ExpoSecretStore(`${name}:secrets`),
            connectivity,
            coordination,
            persistence,
            destroy: async () => {
                await Promise.all([deleteDatabaseAsync(`${storageName}.db`), blobBytes.clear()]);
            },
            cleanup: async () => {
                await coordination.close();
                connectivity.close();
                await database.closeAsync();
            },
        };
    }
);
