import "fake-indexeddb/auto";
import "temporal-polyfill/global";
import { createNodeSQLitePersistence } from "@tanstack/node-db-sqlite-persistence";
import Database from "better-sqlite3";
import { runPersistenceContract, type ContractAdapter } from "./contracts/persistenceContract.js";
import { IndexedDBPersistenceAdapter } from "./IndexedDBPersistenceAdapter.js";

runPersistenceContract("upstream contract / IndexedDB", (options) => {
    const adapter = new IndexedDBPersistenceAdapter({ databaseName: crypto.randomUUID(), ...options });
    return { adapter, unserializable: () => undefined, cleanup: () => adapter.close() };
});
runPersistenceContract("upstream contract / SQLite control", (options) => {
    const database = new Database(":memory:");
    const { adapter } = createNodeSQLitePersistence({ database, ...options });
    return { adapter: adapter as ContractAdapter, unserializable: new Date(Number.NaN), cleanup: () => { database.close(); } };
});
