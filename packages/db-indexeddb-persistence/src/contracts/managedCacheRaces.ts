import { IR } from "@tanstack/db";
import { eagerStorageTarget, type PersistedStorageTarget } from "@tanstack/db-sqlite-persistence-core";
import { openDB } from "idb";
// IndexedDB equivalents of upstream SQLite's held-registration and read-revocation histories.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { IndexedDBPersistenceAdapter } from "../IndexedDBPersistenceAdapter.js";
import { indexedDBManagedCacheHarness } from "./indexedDBManagedCacheHarness.js";
import { target, type ManagedAdapter, type ManagedCacheHarness } from "./managedCacheContract.js";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}
const write = (key: string) => ({
    txId: key,
    term: 1,
    seq: 1,
    rowVersion: 1,
    mutations: [{ type: "insert" as const, key, value: { id: key } }],
});
const indexSpec = { expressionSql: [JSON.stringify(new IR.PropRef(["id"]))] };
const operations = {
    resume: (adapter: ManagedAdapter, storage: PersistedStorageTarget) => adapter.loadResumeSnapshot(storage),
    metadataResume: (adapter: ManagedAdapter, storage: PersistedStorageTarget) =>
        adapter.loadResumeSnapshot(storage, { includeRows: false }),
    subset: (adapter: ManagedAdapter, storage: PersistedStorageTarget) => adapter.loadSubset(storage, {}),
    cursor: (adapter: ManagedAdapter, storage: PersistedStorageTarget) =>
        adapter.loadSubset(storage, {
            cursor: { whereCurrent: new IR.Value(true), whereFrom: new IR.Value(true) },
            limit: 1,
        }),
    metadata: (adapter: ManagedAdapter, storage: PersistedStorageTarget) =>
        adapter.loadCollectionMetadata(storage),
    scan: (adapter: ManagedAdapter, storage: PersistedStorageTarget) => adapter.scanRows(storage),
    metadataScan: (adapter: ManagedAdapter, storage: PersistedStorageTarget) =>
        adapter.scanRows(storage, { metadataOnly: true }),
    position: (adapter: ManagedAdapter, storage: PersistedStorageTarget) =>
        adapter.getStreamPosition(storage),
    replay: (adapter: ManagedAdapter, storage: PersistedStorageTarget) => adapter.pullSince(storage, 0),
    write: (adapter: ManagedAdapter, storage: PersistedStorageTarget) =>
        adapter.applyCommittedTx(storage, write("late")),
    index: (adapter: ManagedAdapter, storage: PersistedStorageTarget) =>
        adapter.ensureIndex(storage, "late-index", indexSpec),
    removeIndex: (adapter: ManagedAdapter, storage: PersistedStorageTarget) =>
        adapter.markIndexRemoved(storage, "late-index"),
};
type Initialization = { collectionDatabase: (...args: unknown[]) => Promise<unknown> };
export function runManagedCacheRaces(name: string): void {
    const harnesses: ManagedCacheHarness[] = [];
    function use(options = {}) {
        const h = indexedDBManagedCacheHarness(options);
        harnesses.push(h);
        return h;
    }
    afterEach(async () => {
        vi.restoreAllMocks();
        for (const h of harnesses.splice(0)) await h.cleanup();
    });
    describe(`${name}`, () => {
        it("upgrades a v3 database without losing eager rows, metadata, or pending actions", async () => {
            const name = `managed-upgrade-${crypto.randomUUID()}`;
            const old = await openDB(name, 3, {
                upgrade(database) {
                    const rows = database.createObjectStore("rows", { keyPath: "id" });
                    rows.createIndex("collectionId", "collectionId");
                    rows.createIndex("metadata", ["collectionId", "hasMetadata"]);
                    const transactions = database.createObjectStore("transactions", { keyPath: "id" });
                    transactions.createIndex("collectionId", "collectionId");
                    transactions.createIndex("version", ["collectionId", "rowVersion"]);
                    transactions.createIndex("position", ["collectionId", "term", "seq"]);
                    database.createObjectStore("streams", { keyPath: "collectionId" });
                    database
                        .createObjectStore("collectionMetadata", { keyPath: "id" })
                        .createIndex("collectionId", "collectionId");
                    database
                        .createObjectStore("indexDefinitions", { keyPath: ["collectionId", "signature"] })
                        .createIndex("collectionId", "collectionId");
                    const entries = database.createObjectStore("indexEntries", {
                        keyPath: ["collectionId", "signature", "valueType", "rowId"],
                    });
                    entries.createIndex("collectionId", "collectionId");
                    entries.createIndex("index", ["collectionId", "signature"]);
                    entries.createIndex("lookup", [
                        "collectionId",
                        "signature",
                        "valueType",
                        "value",
                        "rowId",
                    ]);
                },
            });
            await old.put("rows", {
                id: JSON.stringify(["outbox", "s:pending"]),
                collectionId: "outbox",
                key: "pending",
                value: { id: "pending", action: "create" },
            });
            await old.put("streams", {
                collectionId: "outbox",
                schemaVersion: 1,
                latestTerm: 1,
                latestSeq: 1,
                latestRowVersion: 1,
            });
            await old.put("collectionMetadata", {
                id: JSON.stringify(["outbox", "resume"]),
                collectionId: "outbox",
                key: "resume",
                value: "legacy-cursor",
            });
            old.close();
            const adapter = new IndexedDBPersistenceAdapter({ databaseName: name });
            try {
                const snapshot = await adapter.loadResumeSnapshot(eagerStorageTarget("outbox"));
                expect(snapshot.rows).toEqual([
                    { key: "pending", value: { id: "pending", action: "create" }, metadata: undefined },
                ]);
                expect(snapshot.collectionMetadata).toEqual([{ key: "resume", value: "legacy-cursor" }]);
                expect(snapshot.latestRowVersion).toBe(1);
                const claim = await adapter.claimCacheGeneration("outbox");
                expect(claim.storageCollectionId).not.toBe("outbox");
                expect((await adapter.loadResumeSnapshot(target(claim))).rows).toEqual([]);
                expect(
                    (await adapter.loadResumeSnapshot(eagerStorageTarget("outbox"))).rows.map((r) => r.key)
                ).toEqual(["pending"]);
                const database = await openDB(name);
                expect(database.version).toBe(4);
                expect(Array.from(database.objectStoreNames)).toEqual(
                    expect.arrayContaining(["cacheGenerations", "cacheHeads", "cacheClaims"])
                );
                database.close();
            } finally {
                adapter.close();
                await new Promise<void>((resolve, reject) => {
                    const request = indexedDB.deleteDatabase(name);
                    request.onsuccess = () => resolve();
                    request.onerror = () =>
                        reject(request.error ?? new Error("Could not delete migration database"));
                });
            }
        });

        it("serializes claims and conditional rotations across independent connections", async () => {
            const h = use();
            const peer = h.reopen();
            const claims = await Promise.all(
                Array.from({ length: 12 }, (_, i) =>
                    (i % 2 ? peer : h.adapter).claimCacheGeneration("concurrent")
                )
            );
            expect(new Set(claims.map((claim) => claim.storageCollectionId)).size).toBe(1);
            expect(new Set(claims.map((claim) => claim.claimId)).size).toBe(12);
            const first = claims[0]!;
            const rotations = await Promise.allSettled(
                [h.adapter, peer].map((adapter) =>
                    adapter.rotateCacheGeneration(
                        "concurrent",
                        first.claimId,
                        undefined,
                        first.storageCollectionId
                    )
                )
            );
            expect(rotations.filter((result) => result.status === "fulfilled")).toHaveLength(1);
            expect(rotations.filter((result) => result.status === "rejected")).toHaveLength(1);
            expect((await peer.claimCacheGeneration("concurrent")).storageCollectionId).not.toBe(
                first.storageCollectionId
            );
            await h.adapter.applyCommittedTx(target(claims[1]!), write("old-peer"));
            expect((await peer.loadResumeSnapshot(target(claims[1]!))).rows.map((row) => row.key)).toEqual([
                "old-peer",
            ]);
        });

        const histories = Object.entries(operations).flatMap(([operation, run]) =>
            (["before", "after"] as const).map((phase) => ({ operation, run, phase }))
        );
        it.each(histories)(
            "does not resurrect collected storage when $operation pauses $phase initialization",
            async ({ run, phase }) => {
                const h = use();
                const { adapter } = h;
                const moving = await adapter.claimCacheGeneration("held-registration");
                const warm = await adapter.claimCacheGeneration("held-registration");
                await adapter.applyCommittedTx(target(moving), write("old"));
                const reader = h.reopen();
                const internals = reader as unknown as Initialization;
                const original = internals.collectionDatabase.bind(reader);
                const entered = deferred();
                const released = deferred();
                vi.spyOn(internals, "collectionDatabase").mockImplementationOnce(async (...args) => {
                    const result = phase === "after" ? await original(...args) : undefined;
                    entered.resolve();
                    await released.promise;
                    return phase === "after" ? result : original(...args);
                });
                const read = run(reader, target(warm));
                void read.catch(() => undefined);
                try {
                    await entered.promise;
                    const current = await adapter.rotateCacheGeneration("held-registration", moving.claimId);
                    await adapter.applyCommittedTx(target(current), write("current"));
                    await adapter.releaseCacheGenerationClaim(warm.claimId);
                    const footprint = await h.footprint(moving.storageCollectionId);
                    expect(Object.values(footprint).every((count) => count === 0)).toBe(true);
                    released.resolve();
                    await expect(read).rejects.toThrow("no longer active");
                    expect(await h.footprint(moving.storageCollectionId)).toEqual(footprint);
                    expect(
                        (await adapter.loadResumeSnapshot(target(current))).rows.map((r) => r.key)
                    ).toEqual(["current"]);
                } finally {
                    released.resolve();
                    await Promise.allSettled([read]);
                }
            }
        );

        const reads = Object.entries(operations).map(([operation, run]) => ({ operation, run }));
        it.each(reads)(
            "fences $operation after registration when its claim expires while a peer remains live",
            async ({ run }) => {
                let now = 1_000;
                const h = use({ cacheGenerationClaimTtlMs: 100, now: () => now });
                const { adapter } = h;
                const paused = await adapter.claimCacheGeneration("read-claim");
                const warm = await adapter.claimCacheGeneration("read-claim");
                await adapter.applyCommittedTx(target(warm), write("warm"));
                const reader = h.reopen();
                const internals = reader as unknown as Initialization;
                const original = internals.collectionDatabase.bind(reader);
                const entered = deferred();
                const released = deferred();
                vi.spyOn(internals, "collectionDatabase").mockImplementationOnce(async (...args) => {
                    const result = await original(...args);
                    entered.resolve();
                    await released.promise;
                    return result;
                });
                const read = run(reader, target(paused));
                void read.catch(() => undefined);
                try {
                    await entered.promise;
                    now = 1_090;
                    await adapter.renewCacheGenerationClaim(warm.storageCollectionId, warm.claimId);
                    now = 1_100;
                    const footprint = await h.footprint(warm.storageCollectionId);
                    released.resolve();
                    await expect(read).rejects.toThrow("no longer active");
                    expect(await h.footprint(warm.storageCollectionId)).toEqual(footprint);
                    expect((await adapter.loadResumeSnapshot(target(warm))).rows.map((r) => r.key)).toEqual([
                        "warm",
                    ]);
                } finally {
                    released.resolve();
                    await Promise.allSettled([read]);
                }
            }
        );

        it("preserves a warm generation when an expired reader would reset its schema", async () => {
            let now = 1_000;
            const h = use({ cacheGenerationClaimTtlMs: 100, now: () => now });
            const claim = await h.adapter.claimCacheGeneration("stale-schema-reset");
            const warm = await h.adapter.claimCacheGeneration("stale-schema-reset");
            await h.adapter.applyCommittedTx(target(claim), {
                ...write("warm"),
                collectionMetadataMutations: [{ type: "set", key: "resume", value: "cursor" }],
            });
            const reader = h.reopen({ schemaVersion: 2, schemaMismatchPolicy: "sync-present-reset" });
            now = 1_090;
            await h.adapter.renewCacheGenerationClaim(warm.storageCollectionId, warm.claimId);
            now = 1_100;
            const footprint = await h.footprint(warm.storageCollectionId);
            await expect(reader.loadResumeSnapshot(target(claim))).rejects.toThrow("no longer active");
            expect(await h.footprint(warm.storageCollectionId)).toEqual(footprint);
            expect((await h.adapter.loadResumeSnapshot(target(warm))).collectionMetadata).toEqual([
                { key: "resume", value: "cursor" },
            ]);
        });

        it("keeps eager storage usable after managed cache activity", async () => {
            const h = use();
            const claim = await h.adapter.claimCacheGeneration("managed");
            await h.adapter.applyCommittedTx(target(claim), write("managed"));
            await h.adapter.applyCommittedTx(eagerStorageTarget("local-outbox"), write("pending"));
            await h.adapter.rotateCacheGeneration("managed", claim.claimId);
            expect(
                (await h.adapter.loadResumeSnapshot(eagerStorageTarget("local-outbox"))).rows.map(
                    (row) => row.key
                )
            ).toEqual(["pending"]);
        });
    });
}
