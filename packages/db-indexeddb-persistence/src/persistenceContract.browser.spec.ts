import { runPersistenceContract } from "./contracts/persistenceContract.js";
import { IndexedDBPersistenceAdapter } from "./IndexedDBPersistenceAdapter.js";
runPersistenceContract("upstream contract / native IndexedDB", (options) => {
    const name = `contract-${crypto.randomUUID()}`;
    const adapter = new IndexedDBPersistenceAdapter({ databaseName: name, ...options });
    return { adapter, unserializable: () => undefined, cleanup: async () => {
        adapter.close();
        await new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error ?? new Error("Database deletion failed"));
            request.onblocked = () => reject(new Error("Contract database remained open"));
        });
    } };
});
