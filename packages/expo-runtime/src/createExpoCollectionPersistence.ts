import { createCollectionAdapterPersistence } from "@party-stack/runtime";
import {
    createSQLiteCorePersistenceAdapter,
    DEFAULT_APPLIED_TX_PRUNE_MAX_ROWS,
    DEFAULT_APPLIED_TX_PRUNE_MAX_AGE_SECONDS,
} from "@tanstack/db-sqlite-persistence-core";
import { ExpoSQLiteDriver } from "@tanstack/expo-db-sqlite-persistence/expo-sqlite-driver";
import type { ExpoSQLiteDatabaseLike } from "@tanstack/expo-db-sqlite-persistence";

export function createExpoCollectionPersistence(database: ExpoSQLiteDatabaseLike) {
    const driver = new ExpoSQLiteDriver({ database });
    return createCollectionAdapterPersistence(({ mode, schemaVersion }) =>
        createSQLiteCorePersistenceAdapter({
            driver,
            schemaVersion,
            schemaMismatchPolicy: mode === "sync-present" ? "sync-present-reset" : "sync-absent-error",
            appliedTxPruneMaxRows: DEFAULT_APPLIED_TX_PRUNE_MAX_ROWS,
            appliedTxPruneMaxAgeSeconds: DEFAULT_APPLIED_TX_PRUNE_MAX_AGE_SECONDS,
        })
    );
}
