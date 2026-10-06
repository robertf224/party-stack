import { IndexedDBConnection, IndexedDBPersistenceAdapter } from "./IndexedDBPersistenceAdapter.js";
import type { IndexedDBPersistenceAdapterOptions } from "./IndexedDBPersistenceAdapter.js";
import type {
    PersistedCollectionCoordinator,
    PersistedCollectionMode,
    PersistedCollectionPersistence,
} from "@tanstack/db-sqlite-persistence-core";

export type IndexedDBSchemaMismatchPolicy =
    | NonNullable<IndexedDBPersistenceAdapterOptions["schemaMismatchPolicy"]>
    | "throw";

export type IndexedDBPersistenceOptions = Omit<
    IndexedDBPersistenceAdapterOptions,
    "schemaVersion" | "schemaMismatchPolicy"
> & {
    coordinator?: PersistedCollectionCoordinator;
    schemaMismatchPolicy?: IndexedDBSchemaMismatchPolicy;
};

/** Create shared persistence with the same collection resolver as TanStack's SQLite factories. */
export function createIndexedDBPersistence(
    options: IndexedDBPersistenceOptions
): PersistedCollectionPersistence & { close: () => void } {
    const { coordinator, schemaMismatchPolicy, ...baseOptions } = options;
    const connection = new IndexedDBConnection(baseOptions);
    let closed = false;
    const resolve = (
        mode: PersistedCollectionMode,
        schemaVersion?: number
    ): PersistedCollectionPersistence => {
        if (closed) throw new Error("IndexedDB persistence is closed.");
        const policy =
            schemaMismatchPolicy === "throw"
                ? "sync-absent-error"
                : (schemaMismatchPolicy ??
                  (mode === "sync-present" ? "sync-present-reset" : "sync-absent-error"));
        const adapter = new IndexedDBPersistenceAdapter({
            ...baseOptions,
            schemaVersion,
            schemaMismatchPolicy: policy,
        }, connection);
        // Without a supplied coordinator, TanStack creates a collection-local default.
        return { adapter, ...(coordinator ? { coordinator } : {}) };
    };
    const root = resolve("sync-absent");
    const rootAdapter = root.adapter as IndexedDBPersistenceAdapter;
    return {
        ...root,
        resolvePersistenceForCollection: ({ mode, schemaVersion }) => resolve(mode, schemaVersion),
        resolvePersistenceForMode: (mode) => resolve(mode),
        close: () => {
            closed = true;
            rootAdapter.close();
            connection.close();
        },
    };
}
