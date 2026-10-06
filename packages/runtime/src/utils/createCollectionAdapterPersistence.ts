import type {
    PersistedCollectionMode,
    PersistedCollectionPersistence,
    PersistenceAdapter,
} from "@tanstack/db-sqlite-persistence-core";

/** Resolve collection-owned adapters without retaining a cache of schema variants. */
export function createCollectionAdapterPersistence(
    createAdapter: (options: {
        collectionId: string;
        mode: PersistedCollectionMode;
        schemaVersion?: number;
    }) => PersistenceAdapter
): PersistedCollectionPersistence {
    return {
        adapter: createAdapter({ collectionId: "", mode: "sync-absent" }),
        resolvePersistenceForCollection: (context) => ({
            adapter: createAdapter(context),
        }),
        resolvePersistenceForMode: (mode) => ({ adapter: createAdapter({ collectionId: "", mode }) }),
    };
}
