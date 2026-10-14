import "fake-indexeddb/auto";
import { createPersistedTableName } from "@tanstack/db-sqlite-persistence-core";
import { createNodeSQLitePersistence } from "@tanstack/node-db-sqlite-persistence";
import Database from "better-sqlite3";
import { indexedDBManagedCacheHarness } from "./contracts/indexedDBManagedCacheHarness.js";
import { runManagedCacheContract, type ManagedAdapter } from "./contracts/managedCacheContract.js";
import type { PersistedCacheGenerationClaim } from "@tanstack/db-sqlite-persistence-core";

runManagedCacheContract("managed cache / IndexedDB", indexedDBManagedCacheHarness);
runManagedCacheContract("managed cache / SQLite control", (options) => {
    const database = new Database(":memory:");
    const create = (overrides = {}) =>
        createNodeSQLitePersistence({ database, ...options, ...overrides }).adapter as ManagedAdapter;
    return {
        adapter: create(),
        reopen: create,
        footprint: (id) => {
            const count = (table: string, column?: string) => {
                if (!database.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(table)) return 0;
                return (
                    database
                        .prepare(
                            `SELECT COUNT(*) AS count FROM "${table}"${column ? ` WHERE ${column} = ?` : ""}`
                        )
                        .get(...(column ? [id] : [])) as { count: number }
                ).count;
            };
            return Promise.resolve({
                rows: count(createPersistedTableName(id, "c")),
                tombstones: count(createPersistedTableName(id, "t")),
                transactions: count("applied_tx", "collection_id"),
                collectionMetadata: count("collection_metadata", "collection_id"),
                streams: count("collection_version", "collection_id"),
                indexes: count("persisted_index_registry", "collection_id"),
                generations: count("cache_generation", "physical_id"),
                claims: count("cache_generation_claim", "physical_id"),
                registry: count("collection_registry", "collection_id"),
                expectedKeys: count("collection_expected_keys", "collection_id"),
            });
        },
        claims: (logicalId) =>
            Promise.resolve(
                database
                    .prepare(
                        "SELECT physical_id AS storageCollectionId, claim_id AS claimId, expires_at_ms AS expiresAtMs FROM cache_generation_claim WHERE logical_id = ?"
                    )
                    .all(logicalId) as PersistedCacheGenerationClaim[]
            ),
        cleanup: () => {
            database.close();
        },
    };
});
