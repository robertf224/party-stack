import { openDB } from "idb";
import { IndexedDBPersistenceAdapter } from "../IndexedDBPersistenceAdapter.js";
import type { ManagedCacheFactory } from "./managedCacheContract.js";
import type { PersistedCacheGenerationClaim } from "@tanstack/db-sqlite-persistence-core";

const stores = [
    "rows",
    "transactions",
    "collectionMetadata",
    "streams",
    "indexDefinitions",
    "indexEntries",
    "cacheGenerations",
    "cacheClaims",
];
type RecordIdentity = { collectionId?: string; storageCollectionId?: string; logicalId?: string };
export const indexedDBManagedCacheHarness: ManagedCacheFactory = (options = {}) => {
    const name = `managed-contract-${crypto.randomUUID()}`;
    const adapters: IndexedDBPersistenceAdapter[] = [];
    const create = (overrides = {}) => {
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: name, ...options, ...overrides });
        adapters.push(adapter);
        return adapter;
    };
    return {
        adapter: create(),
        reopen: create,
        footprint: async (id) => {
            const database = await openDB(name);
            try {
                const transaction = database.transaction(stores, "readonly");
                const result: Record<string, number> = {};
                for (const store of stores) {
                    const records = (await transaction.objectStore(store).getAll()) as RecordIdentity[];
                    result[store === "cacheClaims" ? "claims" : store] = records.filter(
                        (row) => (row.collectionId ?? row.storageCollectionId) === id
                    ).length;
                }
                await transaction.done;
                return result;
            } finally {
                database.close();
            }
        },
        claims: async (logicalId) => {
            const database = await openDB(name);
            try {
                const claims = (await database.getAll("cacheClaims")) as Array<
                    PersistedCacheGenerationClaim & { logicalId: string }
                >;
                return claims.filter((claim) => claim.logicalId === logicalId);
            } finally {
                database.close();
            }
        },
        cleanup: async () => {
            for (const adapter of adapters) adapter.close();
            await new Promise<void>((resolve, reject) => {
                const request = indexedDB.deleteDatabase(name);
                request.onsuccess = () => resolve();
                request.onerror = () =>
                    reject(request.error ?? new Error("Could not delete contract database"));
                request.onblocked = () => reject(new Error("Contract database remained open"));
            });
        },
    };
};
