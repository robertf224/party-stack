import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { SingleProcessCoordination } from "@party-stack/coordination";
import { createLocalCollection, MemoryBlobBytesStore } from "@party-stack/runtime";
import { describe, expect, it } from "vitest";
import { createExpoCollectionPersistence } from "./createExpoCollectionPersistence.js";
import type { ExpoSQLiteDatabaseLike } from "@tanstack/expo-db-sqlite-persistence";
import type { ExpoSQLiteBindParams } from "@tanstack/expo-db-sqlite-persistence/expo-sqlite-driver";

function inputs(params?: ExpoSQLiteBindParams): SQLInputValue[] {
    if (params === undefined) return [];
    if (!Array.isArray(params)) throw new Error("Expected positional SQLite bindings.");
    return params.map((value: unknown) => {
        if (value === null || typeof value === "string" || typeof value === "number" || value instanceof Uint8Array) return value;
        throw new Error("Unsupported test SQLite binding.");
    });
}

describe("collection-owned Expo persistence", () => {
    it("shares the Expo driver queue across independent schemas and preserves stored data after reopening", async () => {
        const sqlite = new DatabaseSync(":memory:");
        let concurrentTransactions = 0;
        let maximumTransactions = 0;
        const queryable = {
            execAsync: (sql: string) => { sqlite.exec(sql); return Promise.resolve(); },
            getAllAsync: <T>(sql: string, params?: ExpoSQLiteBindParams): Promise<ReadonlyArray<T>> =>
                Promise.resolve(sqlite.prepare(sql).all(...inputs(params)) as unknown as ReadonlyArray<T>),
            runAsync: (sql: string, params?: ExpoSQLiteBindParams) => {
                const result = sqlite.prepare(sql).run(...inputs(params));
                return Promise.resolve({ changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) });
            },
        };
        const database: ExpoSQLiteDatabaseLike = {
            ...queryable,
            withExclusiveTransactionAsync: async (task) => {
                concurrentTransactions++;
                maximumTransactions = Math.max(maximumTransactions, concurrentTransactions);
                sqlite.exec("BEGIN");
                try {
                    // A second driver queue would enter another transaction during this yield.
                    await Promise.resolve();
                    await task(queryable);
                    sqlite.exec("COMMIT");
                } catch (error) {
                    sqlite.exec("ROLLBACK");
                    throw error;
                } finally {
                    concurrentTransactions--;
                }
            },
        };
        const persistence = createExpoCollectionPersistence(database);
        const coordination = new SingleProcessCoordination({ scope: "expo-adapter-lifetimes" });
        const runtime = { owner: "owner", namespace: "expo", coordination, persistence, blobBytes: new MemoryBlobBytesStore() };
        const open = (name: string, schemaVersion: number) => createLocalCollection<{ id: string; label: string }, string>({ name, schemaVersion, runtime, getKey: (row) => row.id });
        const first = open("first", 2);
        const second = open("second", 7);
        const third = open("third", 2);
        try {
            await Promise.all([first.preload(), second.preload(), third.preload()]);
            await Promise.all([first, second, third].map(async (collection, index) => {
                await collection.insert({ id: "saved", label: `Collection ${index}` }).isPersisted.promise;
            }));
            expect(maximumTransactions).toBe(1);
            expect(second.get("saved")?.label).toBe("Collection 1");
            const resolve = persistence.resolvePersistenceForCollection!;
            expect(resolve({ collectionId: first.id, mode: "sync-absent", schemaVersion: 2 }).adapter).not.toBe(resolve({ collectionId: third.id, mode: "sync-absent", schemaVersion: 2 }).adapter);
            await first.cleanup();
            const incompatible = resolve({ collectionId: first.id, mode: "sync-absent", schemaVersion: 3 });
            await expect(incompatible.adapter.loadResumeSnapshot(first.id)).rejects.toThrow(/schema/i);
            const reopened = open("first", 2);
            await reopened.preload();
            expect(reopened.get("saved")?.label).toBe("Collection 0");
            await reopened.cleanup();
        } finally {
            await Promise.all([first.cleanup(), second.cleanup(), third.cleanup()]);
            await coordination.close();
            sqlite.close();
        }
    });
});
