// Adapted from TanStack/db's SQLite resume snapshot oracle (MIT); see NOTICE.md.
import { IR, createCollection, whenSyncAccepted } from "@tanstack/db";
import {
    eagerStorageTarget,
    managedStorageTarget,
    persistedCollectionOptions,
    type HydrationPersistenceAdapter,
    type PersistedCacheGenerationClaim,
    type PersistedTx,
    type SQLiteCoreAdapterOptions,
} from "@tanstack/db-sqlite-persistence-core";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { SyncConfig } from "@tanstack/db";

export type ManagedAdapter = HydrationPersistenceAdapter &
    Required<
        Pick<
            HydrationPersistenceAdapter,
            | "claimCacheGeneration"
            | "rotateCacheGeneration"
            | "renewCacheGenerationClaim"
            | "releaseCacheGenerationClaim"
            | "loadCollectionMetadata"
            | "scanRows"
            | "getStreamPosition"
            | "markIndexRemoved"
            | "pullSince"
            | "getCacheGenerationNow"
        >
    >;
export interface ManagedCacheHarness {
    adapter: ManagedAdapter;
    reopen(options?: Partial<SQLiteCoreAdapterOptions>): ManagedAdapter;
    footprint(storageCollectionId: string): Promise<Record<string, number>>;
    claims(logicalId: string): Promise<PersistedCacheGenerationClaim[]>;
    cleanup(): Promise<void> | void;
}
export type ManagedCacheFactory = (
    options?: Pick<SQLiteCoreAdapterOptions, "now" | "cacheGenerationClaimTtlMs">
) => ManagedCacheHarness;
export function target(claim: PersistedCacheGenerationClaim) {
    return managedStorageTarget(claim.storageCollectionId, claim.claimId);
}
function seed(key = "seed", rowVersion = 1): PersistedTx {
    return {
        txId: key,
        term: 1,
        seq: rowVersion,
        rowVersion,
        mutations: [{ type: "insert", key, value: { id: key } }],
    };
}
const indexSpec = { expressionSql: [JSON.stringify(new IR.PropRef(["id"]))] };

export function runManagedCacheContract(name: string, factory: ManagedCacheFactory): void {
    const harnesses: ManagedCacheHarness[] = [];
    function use(options?: Parameters<ManagedCacheFactory>[0]) {
        const h = factory(options);
        harnesses.push(h);
        return h;
    }
    afterEach(async () => {
        await Promise.all(
            harnesses.splice(0).map(async (h) => {
                await h.cleanup();
            })
        );
    });
    describe(`${name}`, () => {
        it("mirrors SQLite claim TTL defaults, custom clocks, and option validation", async () => {
            const h = use({ now: () => 1_000 });
            const claim = await h.adapter.claimCacheGeneration("defaults");
            expect(h.adapter.getCacheGenerationNow()).toBe(1_000);
            expect(claim.expiresAtMs).toBe(301_000);
            for (const ttl of [0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
                expect(() => h.reopen({ cacheGenerationClaimTtlMs: ttl })).toThrow(/./);
        });

        it("shares the current generation while giving each run a distinct claim", async () => {
            const h = use();
            const first = await h.adapter.claimCacheGeneration("employees");
            const second = await h.reopen().claimCacheGeneration("employees");
            expect(first.storageCollectionId).toBe(second.storageCollectionId);
            expect(first.claimId).not.toBe(second.claimId);
            expect(first.storageCollectionId).not.toBe("employees");
            const other = await h.adapter.claimCacheGeneration("other");
            expect(other.storageCollectionId).not.toBe(first.storageCollectionId);
        });

        it("starts managed storage separately from legacy eager rows and local-only data", async () => {
            const h = use();
            await h.adapter.applyCommittedTx(eagerStorageTarget("employees"), seed("legacy"));
            const claim = await h.adapter.claimCacheGeneration("employees");
            expect((await h.adapter.loadResumeSnapshot(target(claim))).rows).toEqual([]);
            expect(
                (await h.adapter.loadResumeSnapshot(eagerStorageTarget("employees"))).rows.map((r) => r.key)
            ).toEqual(["legacy"]);
        });

        it("keeps a collected managed target from becoming eager storage", async () => {
            const h = use();
            const { adapter } = h;
            const claim = await adapter.claimCacheGeneration("target-after-collection");
            const managed = target(claim);
            await adapter.applyCommittedTx(managed, seed());
            expect((await adapter.loadResumeSnapshot(managed)).rows).toMatchObject([
                { key: "seed", value: { id: "seed" } },
            ]);
            await adapter.rotateCacheGeneration("target-after-collection", claim.claimId);
            const collected = await h.footprint(claim.storageCollectionId);
            expect(Object.values(collected).every((count) => count === 0)).toBe(true);
            for (const bare of [claim.storageCollectionId, "ordinary-bare-id"]) {
                await expect(adapter.loadResumeSnapshot(bare as never)).rejects.toThrow(
                    "explicit eager or managed storage target"
                );
                await expect(adapter.applyCommittedTx(bare as never, seed())).rejects.toThrow(
                    "explicit eager or managed storage target"
                );
            }
            await expect(
                adapter.loadResumeSnapshot({
                    kind: "managed",
                    storageCollectionId: claim.storageCollectionId,
                } as never)
            ).rejects.toThrow("requires a storageCollectionId and persisted cache claim");
            await expect(
                adapter.loadResumeSnapshot({
                    kind: "eager",
                    collectionId: claim.storageCollectionId,
                    claimId: claim.claimId,
                } as never)
            ).rejects.toThrow("cannot carry a persisted cache claim");
            const lateOperations = [
                () => adapter.loadSubset(managed, {}),
                () => adapter.loadResumeSnapshot(managed),
                () => adapter.loadCollectionMetadata(managed),
                () => adapter.scanRows(managed),
                () => adapter.scanRows(managed, { metadataOnly: true }),
                () => adapter.getStreamPosition(managed),
                () => adapter.pullSince(managed, 0),
                () => adapter.applyCommittedTx(managed, seed("late", 2)),
                () => adapter.ensureIndex(managed, "late-index", indexSpec),
                () => adapter.markIndexRemoved(managed, "late-index"),
            ];
            for (const operation of lateOperations) {
                await expect(operation()).rejects.toThrow("no longer active");
                expect(await h.footprint(claim.storageCollectionId)).toEqual(collected);
            }
            const reopened = h.reopen();
            await expect(reopened.loadResumeSnapshot(managed)).rejects.toThrow("no longer active");
            await expect(reopened.applyCommittedTx(managed, seed())).rejects.toThrow("no longer active");
            const eager = eagerStorageTarget(claim.storageCollectionId);
            await reopened.applyCommittedTx(eager, seed("eager"));
            expect((await reopened.loadResumeSnapshot(eager)).rows.map((r) => r.key)).toEqual(["eager"]);
            await expect(reopened.loadResumeSnapshot(managed)).rejects.toThrow("no longer active");
            await expect(reopened.applyCommittedTx(managed, seed("late", 2))).rejects.toThrow(
                "no longer active"
            );
            expect((await reopened.loadResumeSnapshot(eager)).rows.map((r) => r.key)).toEqual(["eager"]);
        });

        it.each(["tanstack-db-cache:user-eager-collection", "\u0000tanstack-db-cache:user-eager-collection"])(
            "allows eager collection names with an internal-looking prefix: %s",
            async (id) => {
                const { adapter } = use();
                await adapter.applyCommittedTx(eagerStorageTarget(id), seed());
                expect((await adapter.loadResumeSnapshot(eagerStorageTarget(id))).rows).toHaveLength(1);
            }
        );

        it("requires a matching claim for every managed operation and legacy claim context", async () => {
            const { adapter } = use();
            const claim = await adapter.claimCacheGeneration("employees");
            const other = await adapter.claimCacheGeneration("other");
            await adapter.applyCommittedTx(target(claim), seed());
            await expect(
                adapter.loadResumeSnapshot(eagerStorageTarget(claim.storageCollectionId))
            ).rejects.toThrow("claim is required");
            await expect(
                adapter.loadResumeSnapshot(managedStorageTarget(claim.storageCollectionId, other.claimId))
            ).rejects.toThrow("no longer active");
            await expect(
                adapter.loadResumeSnapshot(target(claim), { cacheGenerationClaimId: other.claimId })
            ).rejects.toThrow(/./);
            await expect(
                adapter.applyCommittedTx(target(claim), {
                    ...seed("bad", 2),
                    cacheGenerationClaimId: other.claimId,
                })
            ).rejects.toThrow(/./);
            expect(
                (
                    await adapter.loadResumeSnapshot(target(claim), { cacheGenerationClaimId: claim.claimId })
                ).rows.map((r) => r.key)
            ).toEqual(["seed"]);
        });

        it("reclaims retired cache rows after their last claim releases", async () => {
            const h = use();
            const { adapter } = h;
            const first = await adapter.claimCacheGeneration("retired-cache-collection");
            const warm = await adapter.claimCacheGeneration("retired-cache-collection");
            await adapter.applyCommittedTx(target(first), seed("old"));
            const current = await adapter.rotateCacheGeneration("retired-cache-collection", first.claimId);
            await adapter.applyCommittedTx(target(current), seed("current"));
            expect((await adapter.loadResumeSnapshot(target(warm))).rows.map((r) => r.key)).toEqual(["old"]);
            expect((await h.footprint(first.storageCollectionId)).rows).toBe(1);
            await adapter.releaseCacheGenerationClaim(warm.claimId);
            expect(
                Object.values(await h.footprint(first.storageCollectionId)).every((count) => count === 0)
            ).toBe(true);
            expect((await adapter.loadResumeSnapshot(target(current))).rows.map((r) => r.key)).toEqual([
                "current",
            ]);
            expect((await adapter.claimCacheGeneration("retired-cache-collection")).storageCollectionId).toBe(
                current.storageCollectionId
            );
        });

        it("rotates atomically with reset metadata while preserving the warm generation", async () => {
            const h = use();
            const { adapter } = h;
            const first = await adapter.claimCacheGeneration("reset");
            const peer = await adapter.claimCacheGeneration("reset");
            await adapter.applyCommittedTx(target(first), {
                ...seed("old"),
                collectionMetadataMutations: [{ type: "set", key: "resume", value: "old-cursor" }],
            });
            const next = await adapter.rotateCacheGeneration(
                "reset",
                first.claimId,
                { key: "resume", value: { reset: true } },
                first.storageCollectionId
            );
            const snapshot = await adapter.loadResumeSnapshot(target(next));
            expect(snapshot.rows).toEqual([]);
            expect(snapshot.collectionMetadata).toEqual([{ key: "resume", value: { reset: true } }]);
            expect((await adapter.loadResumeSnapshot(target(peer))).collectionMetadata).toEqual([
                { key: "resume", value: "old-cursor" },
            ]);
            expect((await adapter.claimCacheGeneration("reset")).storageCollectionId).toBe(
                next.storageCollectionId
            );
            await expect(
                adapter.rotateCacheGeneration("reset", next.claimId, undefined, first.storageCollectionId)
            ).rejects.toThrow("changed generations");
            expect((await adapter.claimCacheGeneration("reset")).storageCollectionId).toBe(
                next.storageCollectionId
            );
        });

        it("rolls back generation rotation if reset metadata cannot be serialized", async () => {
            const h = use();
            const { adapter } = h;
            const first = await adapter.claimCacheGeneration("reset-rollback");
            await adapter.applyCommittedTx(target(first), seed());
            await expect(
                adapter.rotateCacheGeneration("reset-rollback", first.claimId, {
                    key: "invalid",
                    value: () => {},
                })
            ).rejects.toThrow(/./);
            expect((await adapter.claimCacheGeneration("reset-rollback")).storageCollectionId).toBe(
                first.storageCollectionId
            );
            expect((await adapter.loadResumeSnapshot(target(first))).rows.map((r) => r.key)).toEqual([
                "seed",
            ]);
        });

        it("expires a paused claim and recovers privately without displacing the current cache", async () => {
            let now = 1_000;
            const h = use({ cacheGenerationClaimTtlMs: 100, now: () => now });
            const { adapter } = h;
            const old = await adapter.claimCacheGeneration("expired-cache-claim");
            const paused = await adapter.claimCacheGeneration("expired-cache-claim");
            await adapter.applyCommittedTx(target(old), seed("old"));
            const head = await adapter.rotateCacheGeneration("expired-cache-claim", old.claimId);
            await adapter.applyCommittedTx(target(head), seed("head"));
            now = 1_090;
            expect(await adapter.renewCacheGenerationClaim(head.storageCollectionId, head.claimId)).toBe(
                1_190
            );
            now = 1_110;
            expect((await adapter.claimCacheGeneration("expired-cache-claim")).storageCollectionId).toBe(
                head.storageCollectionId
            );
            await expect(adapter.loadResumeSnapshot(target(paused))).rejects.toThrow("Persisted cache claim");
            expect(
                Object.values(await h.footprint(old.storageCollectionId)).every((count) => count === 0)
            ).toBe(true);
            const recovery = await adapter.rotateCacheGeneration("expired-cache-claim", paused.claimId);
            expect(recovery.storageCollectionId).not.toBe(head.storageCollectionId);
            expect((await adapter.claimCacheGeneration("expired-cache-claim")).storageCollectionId).toBe(
                head.storageCollectionId
            );
            expect((await adapter.loadResumeSnapshot(target(head))).rows.map((r) => r.key)).toEqual(["head"]);
            await adapter.releaseCacheGenerationClaim(recovery.claimId);
            expect(
                Object.values(await h.footprint(recovery.storageCollectionId)).every((count) => count === 0)
            ).toBe(true);
        });

        it("keeps the current cache claimable when its expired claimant recovers", async () => {
            let now = 1_000;
            const { adapter } = use({ cacheGenerationClaimTtlMs: 100, now: () => now });
            const old = await adapter.claimCacheGeneration("expired-head-recovery");
            await adapter.applyCommittedTx(target(old), seed("old"));
            now = 1_101;
            expect(
                await adapter.renewCacheGenerationClaim(old.storageCollectionId, old.claimId)
            ).toBeUndefined();
            const repaired = await adapter.rotateCacheGeneration(
                "expired-head-recovery",
                old.claimId,
                undefined,
                old.storageCollectionId
            );
            const next = await adapter.claimCacheGeneration("expired-head-recovery");
            expect(next.storageCollectionId).toBe(old.storageCollectionId);
            expect(repaired.storageCollectionId).not.toBe(old.storageCollectionId);
            expect((await adapter.loadResumeSnapshot(target(next))).rows.map((r) => r.key)).toEqual(["old"]);
            await expect(adapter.loadResumeSnapshot(target(old))).rejects.toThrow("Persisted cache claim");
        });

        it.each([false, true])(
            "checks claim expiry on a warmed resume snapshot with includeRows=%s",
            async (includeRows) => {
                let now = 1_000;
                const h = use({ cacheGenerationClaimTtlMs: 100, now: () => now });
                const claim = await h.adapter.claimCacheGeneration("resume");
                await h.adapter.applyCommittedTx(target(claim), seed());
                now = 1_099;
                expect(
                    (await h.adapter.loadResumeSnapshot(target(claim), { includeRows })).rows
                ).toHaveLength(includeRows ? 1 : 0);
                now = 1_100;
                await expect(h.adapter.loadResumeSnapshot(target(claim), { includeRows })).rejects.toThrow(
                    "no longer active"
                );
                now = 1_101;
                await expect(h.adapter.loadResumeSnapshot(target(claim), { includeRows })).rejects.toThrow(
                    "no longer active"
                );
            }
        );

        it("rejects delayed writes and index changes from an expired claimant while its peer remains live", async () => {
            let now = 1_000;
            const h = use({ cacheGenerationClaimTtlMs: 100, now: () => now });
            const { adapter } = h;
            const paused = await adapter.claimCacheGeneration("delayed");
            const peer = await adapter.claimCacheGeneration("delayed");
            await adapter.applyCommittedTx(target(peer), seed());
            now = 1_090;
            await adapter.renewCacheGenerationClaim(peer.storageCollectionId, peer.claimId);
            now = 1_100;
            const footprint = await h.footprint(peer.storageCollectionId);
            await expect(adapter.applyCommittedTx(target(paused), seed("late", 2))).rejects.toThrow(
                "no longer active"
            );
            await expect(adapter.ensureIndex(target(paused), "late", indexSpec)).rejects.toThrow(
                "no longer active"
            );
            await expect(adapter.markIndexRemoved(target(paused), "late")).rejects.toThrow(
                "no longer active"
            );
            expect(await h.footprint(peer.storageCollectionId)).toEqual(footprint);
            expect((await adapter.loadResumeSnapshot(target(peer))).rows.map((r) => r.key)).toEqual(["seed"]);
        });

        // The exact finite grammar from upstream's fixed and generated retired-storage histories.
        // Enumerate it entirely rather than adding fast-check as a dependency.
        const histories = (["release", "expire", "renew"] as const).flatMap((oldClaim) =>
            (["release", "expire", "renew"] as const).flatMap((middleClaim) =>
                ([0, 2] as const).flatMap((rowCount) =>
                    [1_170, 1_190, 1_209, 1_210, 1_229, 1_230].map((checkAtMs) => ({
                        oldClaim,
                        middleClaim,
                        rowCount,
                        checkAtMs,
                    }))
                )
            )
        );
        it.each(histories)(
            "collects only unreachable retired storage: $oldClaim/$middleClaim, $rowCount rows, t=$checkAtMs",
            async (history) => {
                let now = 1_000;
                const h = use({ cacheGenerationClaimTtlMs: 100, now: () => now });
                const { adapter } = h;
                const logicalId = "bounded-retired-storage";
                const first = await adapter.claimCacheGeneration(logicalId);
                now = 1_020;
                const oldPeer = await adapter.claimCacheGeneration(logicalId);
                const generations = [first];
                async function seedStorage(generation: number, claim: PersistedCacheGenerationClaim) {
                    await adapter.applyCommittedTx(target(claim), {
                        txId: `g${generation}-seed`,
                        term: generation + 1,
                        seq: 1,
                        rowVersion: 1,
                        truncate: true,
                        mutations: [
                            ...Array.from({ length: history.rowCount }, (_, i) => ({
                                type: "insert" as const,
                                key: `g${generation}-${i}`,
                                value: { id: `g${generation}-${i}` },
                            })),
                            {
                                type: "delete",
                                key: `g${generation}-gone`,
                                value: { id: `g${generation}-gone` },
                            },
                        ],
                        collectionMetadataMutations: [
                            { type: "set", key: "resume", value: `g${generation}-cursor` },
                        ],
                    });
                    await adapter.ensureIndex(target(claim), `g${generation}-index`, indexSpec);
                    return h.footprint(claim.storageCollectionId);
                }
                const footprints = [await seedStorage(0, first)];
                now = 1_040;
                const middle = await adapter.rotateCacheGeneration(logicalId, first.claimId);
                generations.push(middle);
                now = 1_060;
                const middlePeer = await adapter.claimCacheGeneration(logicalId);
                footprints.push(await seedStorage(1, middle));
                now = 1_080;
                const current = await adapter.rotateCacheGeneration(logicalId, middle.claimId);
                generations.push(current);
                footprints.push(await seedStorage(2, current));
                now = 1_110;
                if (history.oldClaim === "release")
                    await adapter.releaseCacheGenerationClaim(oldPeer.claimId);
                const oldRenewed =
                    history.oldClaim === "renew"
                        ? await adapter.renewCacheGenerationClaim(
                              oldPeer.storageCollectionId,
                              oldPeer.claimId
                          )
                        : undefined;
                expect(oldRenewed).toBe(history.oldClaim === "renew" ? 1_210 : undefined);
                now = 1_130;
                if (history.middleClaim === "release")
                    await adapter.releaseCacheGenerationClaim(middlePeer.claimId);
                const middleRenewed =
                    history.middleClaim === "renew"
                        ? await adapter.renewCacheGenerationClaim(
                              middlePeer.storageCollectionId,
                              middlePeer.claimId
                          )
                        : undefined;
                expect(middleRenewed).toBe(history.middleClaim === "renew" ? 1_230 : undefined);
                now = history.checkAtMs;
                const checkpoint = await adapter.claimCacheGeneration(logicalId);
                expect(checkpoint.storageCollectionId).toBe(current.storageCollectionId);
                const peers = [oldPeer, middlePeer, checkpoint];
                for (let i = 0; i < generations.length; i++) {
                    const retained =
                        i === 2 ||
                        (i === 0
                            ? history.oldClaim === "renew" && now < 1_210
                            : history.middleClaim === "renew" && now < 1_230);
                    const footprint = await h.footprint(generations[i]!.storageCollectionId);
                    // Claim counts change independently; retained data must be byte-for-byte stable.
                    const { claims: _before, ...before } = footprints[i]!;
                    const { claims: _after, ...after } = footprint;
                    const empty = Object.fromEntries(Object.keys(before).map((key) => [key, 0]));
                    expect(after).toEqual(retained ? before : empty);
                    const snapshot = retained
                        ? await adapter.loadResumeSnapshot(target(peers[i]!))
                        : undefined;
                    expect(
                        snapshot?.rows.map((r) => r.key).sort((a, b) => String(a).localeCompare(String(b))) ??
                            []
                    ).toEqual(
                        retained ? Array.from({ length: history.rowCount }, (_, j) => `g${i}-${j}`) : []
                    );
                    expect(snapshot?.collectionMetadata ?? []).toEqual(
                        retained ? [{ key: "resume", value: `g${i}-cursor` }] : []
                    );
                }
            }
        );

        it("does not publish startup metadata read under an expired cache claim", async () => {
            let now = 1_000;
            const h = use({ cacheGenerationClaimTtlMs: 1_000_000, now: () => now });
            const { adapter } = h;
            const seedClaim = await adapter.claimCacheGeneration("expired-startup-metadata");
            await adapter.applyCommittedTx(target(seedClaim), {
                ...seed(),
                collectionMetadataMutations: [{ type: "set", key: "resume", value: "old-resume" }],
            });
            await adapter.releaseCacheGenerationClaim(seedClaim.claimId);
            let completeRead!: () => void;
            const heldRead = new Promise<void>((resolve) => {
                completeRead = resolve;
            });
            let readEntered!: () => void;
            const entered = new Promise<void>((resolve) => {
                readEntered = resolve;
            });
            let hold = true;
            const wrap =
                (loan: Pick<HydrationPersistenceAdapter, "loadResumeSnapshot">) =>
                async (...args: Parameters<HydrationPersistenceAdapter["loadResumeSnapshot"]>) => {
                    const snapshot = await loan.loadResumeSnapshot(...args);
                    if (hold) {
                        hold = false;
                        readEntered();
                        await heldRead;
                    }
                    return snapshot;
                };
            const originalScope = adapter.runInHydrationScope?.bind(adapter);
            const originalRead = adapter.loadResumeSnapshot.bind(adapter);
            if (originalScope)
                adapter.runInHydrationScope = (task) =>
                    originalScope((loan) => task({ ...loan, loadResumeSnapshot: wrap(loan) }));
            else adapter.loadResumeSnapshot = wrap({ loadResumeSnapshot: originalRead });
            const resumeValues: unknown[] = [];
            const collection = createCollection(
                persistedCollectionOptions<{ id: string }, string>({
                    id: "expired-startup-metadata",
                    syncMode: "on-demand",
                    getKey: (row) => row.id,
                    sync: {
                        sync: (source) => {
                            resumeValues.push(source.metadata?.collection.get("resume"));
                            source.markReady();
                            return { restartAfterScopedRecovery: () => {} };
                        },
                    },
                    persistence: { adapter },
                })
            );
            try {
                collection.startSyncImmediate();
                await entered;
                expect(resumeValues).toEqual([]);
                now += 1_000_001;
                completeRead();
                await vi.waitFor(() => expect(collection.status).toBe("ready"));
                expect(resumeValues).toEqual([undefined]);
            } finally {
                completeRead();
                await collection.cleanup();
            }
        });

        it("rejects old and queued source commits after claim expiry and permits new writes", async () => {
            let now = 1_000;
            const h = use({ cacheGenerationClaimTtlMs: 1_000_000, now: () => now });
            let source!: Parameters<SyncConfig<{ id: string }, string>["sync"]>[0];
            let restarted!: () => void;
            const recovery = new Promise<void>((resolve) => {
                restarted = resolve;
            });
            const collection = createCollection(
                persistedCollectionOptions<{ id: string }, string>({
                    id: "expired-source-write",
                    syncMode: "on-demand",
                    getKey: (row) => row.id,
                    sync: {
                        sync: (params) => {
                            source = params;
                            params.markReady();
                            return { restartAfterScopedRecovery: (rotated) => rotated.then(restarted) };
                        },
                    },
                    persistence: { adapter: h.adapter },
                })
            );
            try {
                collection.startSyncImmediate();
                await vi.waitFor(() => expect(collection.status).toBe("ready"));
                await source.metadata!.persistence!.hydrateBaseline();
                now += 1_000_001;
                source.begin();
                source.write({ type: "insert", value: { id: "old" } });
                const old = Promise.resolve(source.commit());
                source.begin();
                source.write({ type: "insert", value: { id: "second-old" } });
                const queued = Promise.resolve(source.commit());
                await Promise.all([
                    expect(old).rejects.toThrow("aborted"),
                    expect(queued).rejects.toThrow("aborted"),
                ]);
                await recovery;
                await collection._sync.loadSubset({ limit: 0 });
                source.begin();
                source.write({ type: "insert", value: { id: "fresh" } });
                await whenSyncAccepted(source.commit());
                expect(collection.get("old")).toBeUndefined();
                expect(collection.get("second-old")).toBeUndefined();
                expect(collection.get("fresh")).toMatchObject({ id: "fresh" });
                const claims = await h.claims("expired-source-write");
                expect((await h.adapter.scanRows(target(claims[0]!))).map((row) => row.key)).toEqual([
                    "fresh",
                ]);
            } finally {
                await collection.cleanup();
            }
        });

        it("reloads an active subset when its renewal timer finds an expired claim", async () => {
            let now = 1_000;
            const h = use({ cacheGenerationClaimTtlMs: 100, now: () => now });
            const sourceLoads: Array<boolean | undefined> = [];
            const collection = createCollection(
                persistedCollectionOptions<{ id: string }, string>({
                    id: "timer-claim-reload",
                    syncMode: "on-demand",
                    getKey: (row) => row.id,
                    sync: {
                        sync: (source) => {
                            source.markReady();
                            return {
                                restartAfterScopedRecovery: () => {},
                                loadSubset: (options) => {
                                    sourceLoads.push(options.refetch);
                                    return true;
                                },
                            };
                        },
                    },
                    persistence: { adapter: h.adapter },
                })
            );
            try {
                collection.startSyncImmediate();
                await collection._sync.loadSubset({ limit: 1 });
                expect(sourceLoads).toEqual([undefined]);
                const [old] = await h.claims("timer-claim-reload");
                now = 1_101;
                await vi.waitFor(() => expect(sourceLoads).toHaveLength(2));
                expect(sourceLoads[1]).toBe(true);
                const [current] = await h.claims("timer-claim-reload");
                expect(current!.storageCollectionId).not.toBe(old!.storageCollectionId);
            } finally {
                await collection.cleanup();
            }
        });

        it("restarts a custom source after a real adapter cache claim expires", async () => {
            type Row = { id: string; title: string };
            let now = 1_000;
            const h = use({ cacheGenerationClaimTtlMs: 300_000, now: () => now });
            const sessions: Array<Parameters<SyncConfig<Row, string>["sync"]>[0]> = [];
            let cleanups = 0;
            const collection = createCollection(
                persistedCollectionOptions<Row, string>({
                    id: "custom-expired-cache",
                    syncMode: "on-demand",
                    getKey: (row) => row.id,
                    sync: {
                        sync: (params) => {
                            const session = sessions.push(params);
                            params.markReady();
                            return {
                                cleanup: () => {
                                    cleanups++;
                                },
                                loadSubset: async () => {
                                    params.begin();
                                    params.write({
                                        type: "update",
                                        value: { id: `row-${session}`, title: `Session ${session}` },
                                    });
                                    await whenSyncAccepted(params.commit());
                                },
                            };
                        },
                    },
                    persistence: { adapter: h.adapter },
                })
            );
            try {
                collection.startSyncImmediate();
                await vi.waitFor(() => expect(collection.status).toBe("ready"));
                await collection._sync.loadSubset({ limit: 1 });
                expect(collection.get("row-1")).toMatchObject({ id: "row-1" });
                const [old] = await h.claims("custom-expired-cache");
                now += 300_001;
                await collection._sync.loadSubset({ limit: 2 });
                expect(sessions).toHaveLength(2);
                expect(cleanups).toBe(1);
                expect(collection.get("row-1")).toBeUndefined();
                expect(collection.get("row-2")).toMatchObject({ id: "row-2" });
                const [current] = await h.claims("custom-expired-cache");
                expect(current!.storageCollectionId).not.toBe(old!.storageCollectionId);
                sessions[0]!.begin();
                sessions[0]!.write({ type: "update", value: { id: "late-old", title: "Retired session" } });
                await sessions[0]!.commit();
                expect(collection.get("late-old")).toBeUndefined();
                expect((await h.adapter.loadSubset(target(current!), {})).map((r) => r.key)).toEqual([
                    "row-2",
                ]);
            } finally {
                await collection.cleanup();
            }
        });

        it("moves scoped recovery to a new persisted cache generation", async () => {
            const h = use();
            const { adapter } = h;
            const seedClaim = await adapter.claimCacheGeneration("scoped-generation-boundary");
            await adapter.applyCommittedTx(target(seedClaim), seed("stale"));
            let source!: Parameters<SyncConfig<{ id: string }, string>["sync"]>[0];
            const collection = createCollection(
                persistedCollectionOptions<{ id: string }, string>({
                    id: "scoped-generation-boundary",
                    syncMode: "on-demand",
                    getKey: (row) => row.id,
                    sync: {
                        sync: (params) => {
                            source = params;
                            params.markReady();
                            return { loadSubset: () => true, restartAfterScopedRecovery: () => {} };
                        },
                    },
                    persistence: { adapter },
                })
            );
            try {
                collection.startSyncImmediate();
                await vi.waitFor(() => expect(collection.status).toBe("ready"));
                await collection._sync.loadSubset({});
                expect(collection.get("stale")).toMatchObject({ id: "stale" });
                const capability = source.metadata!.persistence!;
                await capability.startScopedRecovery!({ key: "resume", value: { reset: true } });
                await collection._sync.loadSubset({});
                source.begin();
                source.write({ type: "insert", value: { id: "fresh" } });
                await whenSyncAccepted(source.commit());
                expect(collection.get("stale")).toBeUndefined();
                expect(collection.get("fresh")).toMatchObject({ id: "fresh" });
                expect((await adapter.loadResumeSnapshot(target(seedClaim))).rows.map((r) => r.key)).toEqual([
                    "stale",
                ]);
                const claims = await h.claims("scoped-generation-boundary");
                const current = claims.find(
                    (claim) => claim.storageCollectionId !== seedClaim.storageCollectionId
                )!;
                expect((await adapter.loadResumeSnapshot(target(current))).rows.map((r) => r.key)).toEqual([
                    "fresh",
                ]);
            } finally {
                await collection.cleanup();
            }
        });
    });
}
