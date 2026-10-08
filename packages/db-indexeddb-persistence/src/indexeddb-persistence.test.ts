import "fake-indexeddb/auto";
import { createCollection } from "@tanstack/db";
import { persistedCollectionOptions, SingleProcessCoordinator, type SQLiteCoreAdapterOptions } from "@tanstack/db-sqlite-persistence-core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createIndexedDBPersistence, type IndexedDBPersistenceAdapterOptions, type IndexedDBSchemaMismatchPolicy } from "./index.js";

const databaseName = () => `factory-${crypto.randomUUID()}`;

describe("createIndexedDBPersistence", () => {
    it("uses upstream schema mismatch policies with the standard factory throw alias", () => {
        type UpstreamPolicy = NonNullable<SQLiteCoreAdapterOptions["schemaMismatchPolicy"]>;
        expectTypeOf<NonNullable<IndexedDBPersistenceAdapterOptions["schemaMismatchPolicy"]>>().toEqualTypeOf<UpstreamPolicy>();
        expectTypeOf<IndexedDBSchemaMismatchPolicy>().toEqualTypeOf<UpstreamPolicy | "throw">();
    });

    it("persists and rehydrates a standalone TanStack collection without runtime integration", async () => {
        const name = databaseName();
        const open = () => {
            const persistence = createIndexedDBPersistence({ databaseName: name });
            const collection = createCollection(
                persistedCollectionOptions({
                    id: "tasks",
                    schemaVersion: 3,
                    getKey: (task: { id: string; title: string }) => task.id,
                    persistence,
                })
            );
            return { persistence, collection };
        };
        const first = open();
        await first.collection.preload();
        await first.collection.insert({ id: "saved", title: "Standalone" }).isPersisted.promise;
        await first.collection.cleanup();
        first.persistence.close();
        const second = open();
        await second.collection.preload();
        expect(second.collection.get("saved")).toMatchObject({ id: "saved", title: "Standalone" });
        await second.collection.cleanup();
        second.persistence.close();
    });

    it("creates independent collection adapters while preserving a supplied coordinator", () => {
        const coordinator = new SingleProcessCoordinator();
        const persistence = createIndexedDBPersistence({ databaseName: databaseName(), coordinator });
        const resolve = persistence.resolvePersistenceForCollection!;
        const first = resolve({ collectionId: "a", mode: "sync-absent", schemaVersion: 2 });
        expect(resolve({ collectionId: "b", mode: "sync-absent", schemaVersion: 2 }).adapter).not.toBe(
            first.adapter
        );
        expect(resolve({ collectionId: "a", mode: "sync-present", schemaVersion: 2 }).adapter).not.toBe(
            first.adapter
        );
        expect(resolve({ collectionId: "a", mode: "sync-absent", schemaVersion: 3 }).adapter).not.toBe(
            first.adapter
        );
        expect(first.coordinator).toBe(coordinator);
        expect(persistence.resolvePersistenceForMode!("sync-absent").adapter).not.toBe(persistence.adapter);
        persistence.close();
        expect(() => resolve({ collectionId: "a", mode: "sync-absent" })).toThrow("closed");
    });

    it("shares one connection across independent schemas, allows closing one view, and closes all views with the factory", async () => {
        const open = vi.spyOn(indexedDB, "open");
        const persistence = createIndexedDBPersistence({ databaseName: databaseName() });
        const resolve = persistence.resolvePersistenceForCollection!;
        const first = resolve({ collectionId: "first", mode: "sync-absent", schemaVersion: 2 }).adapter;
        const second = resolve({ collectionId: "second", mode: "sync-absent", schemaVersion: 7 }).adapter;
        try {
            await Promise.all([first.loadResumeSnapshot("first"), second.loadResumeSnapshot("second")]);
            expect(open).toHaveBeenCalledOnce();
            (first as import("./IndexedDBPersistenceAdapter.js").IndexedDBPersistenceAdapter).close();
            await expect(first.loadResumeSnapshot("first")).rejects.toThrow("closed");
            await expect(second.loadResumeSnapshot("second")).resolves.toMatchObject({ rows: [] });
            persistence.close();
            await expect(second.loadResumeSnapshot("second")).rejects.toThrow("closed");
        } finally {
            persistence.close();
            open.mockRestore();
        }
    });

    it("closes a pending shared connection before collection initialization can start", async () => {
        const persistence = createIndexedDBPersistence({ databaseName: databaseName() });
        const view = persistence.resolvePersistenceForCollection!({ collectionId: "pending", mode: "sync-absent", schemaVersion: 2 });
        const load = view.adapter.loadResumeSnapshot("pending");
        persistence.close();
        await expect(load).rejects.toThrow("closed");
    });

    it.each([undefined, "throw"] as const)(
        "preserves local data on mismatch with policy %s",
        async (schemaMismatchPolicy) => {
            const persistence = createIndexedDBPersistence({
                databaseName: databaseName(),
                schemaMismatchPolicy,
            });
            const resolve = persistence.resolvePersistenceForCollection!;
            const original = resolve({
                collectionId: "tasks",
                mode: "sync-absent",
                schemaVersion: 1,
            }).adapter;
            await original.applyCommittedTx("tasks", {
                txId: "seed",
                term: 1,
                seq: 1,
                rowVersion: 1,
                mutations: [{ type: "insert", key: "saved", value: { id: "saved" } }],
            });
            const next = resolve({ collectionId: "tasks", mode: "sync-absent", schemaVersion: 2 }).adapter;
            await expect(next.loadResumeSnapshot("tasks")).rejects.toThrow("Local-only data was preserved");
            expect((await original.loadResumeSnapshot("tasks")).rows).toHaveLength(1);
            persistence.close();
        }
    );

    it.each(["sync-present", "sync-absent"] as const)(
        "resets %s caches when the selected policy allows it",
        async (mode) => {
            const persistence = createIndexedDBPersistence({
                databaseName: databaseName(),
                ...(mode === "sync-absent" ? { schemaMismatchPolicy: "reset" as const } : {}),
            });
            const resolve = persistence.resolvePersistenceForCollection!;
            const original = resolve({ collectionId: "tasks", mode, schemaVersion: 1 }).adapter;
            await original.applyCommittedTx("tasks", {
                txId: "seed",
                term: 1,
                seq: 1,
                rowVersion: 1,
                mutations: [{ type: "insert", key: "saved", value: { id: "saved" } }],
            });
            const next = resolve({ collectionId: "tasks", mode, schemaVersion: 2 }).adapter;
            expect(await next.loadResumeSnapshot("tasks")).toMatchObject({ rows: [], resetEpoch: 1 });
            persistence.close();
        }
    );
});
