import { SingleProcessCoordinator } from "@tanstack/db-sqlite-persistence-core";
import { IndexedDBPersistenceAdapter } from "./IndexedDBPersistenceAdapter.js";
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
    const { coordinator = new SingleProcessCoordinator(), schemaMismatchPolicy, ...baseOptions } = options;
    const adapters = new Map<string, IndexedDBPersistenceAdapter>();
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
        const key = JSON.stringify([policy, schemaVersion ?? 1]);
        let adapter = adapters.get(key);
        if (!adapter) {
            adapter = new IndexedDBPersistenceAdapter({
                ...baseOptions,
                schemaVersion,
                schemaMismatchPolicy: policy,
            });
            adapters.set(key, adapter);
        }
        return { adapter, coordinator };
    };
    return {
        ...resolve("sync-absent"),
        resolvePersistenceForCollection: ({ mode, schemaVersion }) => resolve(mode, schemaVersion),
        resolvePersistenceForMode: (mode) => resolve(mode),
        close: () => {
            closed = true;
            for (const adapter of adapters.values()) adapter.close();
            adapters.clear();
        },
    };
}
