import { IR, whenSyncAccepted, type LoadSubsetOptions } from "@tanstack/db";
import { Effect, Queue, Stream } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { persistedCollectionOptions, scopedCollection } from "./collections.js";
import { getCollectionDemands } from "./diagnostics.js";

type Row = { id: string; value: string };
type Batch = { reset: boolean; rows: readonly { key: string; value: Row }[]; removed: readonly string[] };
const snapshot = (...rows: Row[]): Batch => ({
    reset: true,
    rows: rows.map((value) => ({ key: value.id, value })),
    removed: [],
});
const point = (id: string): LoadSubsetOptions => ({
    where: new IR.Func("eq", [new IR.PropRef(["id"]), new IR.Value(id)]),
});
const fixture = Effect.fnUntraced(function* (
    initial: (subset: LoadSubsetOptions) => Batch | undefined,
    holdCommit?: () => Promise<void> | undefined
) {
    const observers = new Map<LoadSubsetOptions, Queue.Enqueue<Batch>>();
    const deliveries = new Map<LoadSubsetOptions, number>();
    let commits = 0;
    const config = yield* persistedCollectionOptions({
        id: "delta-reconciliation",
        getKey: (row: Row) => row.id,
        primaryKey: "id",
        changes: Stream.never,
        load: Effect.succeed([]),
        describeSubset: (subset) => ({ objectType: "Item", requested: subset }),
        observe: (subset) =>
            Stream.callback<Batch>((queue) =>
                Effect.acquireRelease(
                    Effect.sync(() => {
                        observers.set(subset, queue);
                        const batch = initial(subset);
                        if (batch) Queue.offerUnsafe(queue, batch);
                    }),
                    () => Effect.sync(() => observers.delete(subset))
                )
            ).pipe(
                Stream.tap(() => Effect.sync(() => deliveries.set(subset, (deliveries.get(subset) ?? 0) + 1)))
            ),
    });
    const sync = config.sync.sync;
    const source = yield* scopedCollection({
        ...config,
        sync: {
            ...config.sync,
            sync: (methods) =>
                sync({
                    ...methods,
                    commit: () => {
                        commits++;
                        const receipt = methods.commit();
                        const held = holdCommit?.();
                        return held ? Promise.resolve(whenSyncAccepted(receipt)).then(() => held) : receipt;
                    },
                }),
        },
    });
    const lease = source.subscribeChanges(() => {});
    yield* Effect.addFinalizer(() => Effect.sync(() => lease.unsubscribe()));
    return {
        source,
        commits: () => commits,
        values: () => source.toArray.map(({ id, value }) => ({ id, value })),
        load: (subset: LoadSubsetOptions) => Promise.resolve(source._sync.loadSubset(subset)),
        ready: (subset: LoadSubsetOptions) =>
            vi.waitFor(() => {
                if (!getCollectionDemands(source).find((demand) => demand.requested === subset)?.ready)
                    throw new Error("The test demand has not settled.");
            }),
        publish: (subset: LoadSubsetOptions, batch: Batch) => {
            const queue = observers.get(subset);
            if (!queue) throw new Error("The test demand is not observing.");
            Queue.offerUnsafe(queue, batch);
        },
        unload: (subset: LoadSubsetOptions) => source._sync.unloadSubset(subset),
        observing: (subset: LoadSubsetOptions) =>
            vi.waitFor(() => {
                if (!observers.has(subset)) throw new Error("The test demand has not started observing.");
            }),
        delivered: (subset: LoadSubsetOptions, count: number) =>
            vi.waitFor(() => {
                if (deliveries.get(subset) !== count) throw new Error("The test batch has not arrived.");
            }),
    };
});

test("irrelevant removal hints from empty demands do not refingerprint another demand's rows", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let reads = 0;
                const rows = Array.from({ length: 1400 }, (_, index) => ({
                    id: String(index),
                    get value() {
                        reads++;
                        return `Value ${index}`;
                    },
                }));
                const broad = {};
                const current = yield* fixture((subset) =>
                    subset === broad ? snapshot(...rows) : snapshot()
                );
                yield* Effect.promise(() => current.load(broad));
                yield* Effect.promise(() => current.ready(broad));
                const empty = Array.from({ length: 12 }, (_, index) => point(`missing-${index}`));
                for (const subset of empty) {
                    yield* Effect.promise(() => current.load(subset));
                    yield* Effect.promise(() => current.ready(subset));
                }
                const before = current.commits();
                reads = 0;
                for (const subset of empty)
                    current.publish(subset, {
                        reset: false,
                        rows: [],
                        removed: rows.map((row) => row.id),
                    });
                yield* Effect.promise(() => Promise.all(empty.map((subset) => current.delivered(subset, 2))));
                // Settle a final first batch too: empty results must still become
                // ready and reconcile any pending initial publications.
                const barrier = point("barrier");
                yield* Effect.promise(() => current.load(barrier));
                yield* Effect.promise(() => current.ready(barrier));
                expect(reads).toBe(0);
                expect(current.commits()).toBe(before);
                expect(current.source.size).toBe(1400);
            })
        )
    );
});

test("point demand churn fingerprints only changed keys in a large retained collection", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const reads = new Set<string>();
                const rows = Array.from({ length: 1000 }, (_, index) => ({
                    id: String(index),
                    get value() {
                        reads.add(String(index));
                        return `Value ${index}`;
                    },
                }));
                const broad = {};
                const bySubset = new Map<LoadSubsetOptions, Batch>([[broad, snapshot(...rows)]]);
                const current = yield* fixture((subset) => bySubset.get(subset) ?? snapshot());
                yield* Effect.promise(() => current.load(broad));
                yield* Effect.promise(() => current.ready(broad));
                expect(current.source.size).toBe(1000);
                reads.clear();
                const selected = new Set<string>();
                for (const index of [10, 20, 30, 40]) {
                    const subset = point(String(index));
                    selected.add(String(index));
                    bySubset.set(subset, snapshot(rows[index]!));
                    yield* Effect.promise(() => current.load(subset));
                    yield* Effect.promise(() => current.ready(subset));
                    current.unload(subset);
                }
                const barrier = point("missing");
                yield* Effect.promise(() => current.load(barrier));
                yield* Effect.promise(() => current.ready(barrier));
                expect(reads.size).toBeGreaterThan(0);
                expect([...reads].every((key) => selected.has(key))).toBe(true);
                expect(current.source.size).toBe(1000);
            })
        )
    );
});

test("overlapping demand updates, removal and reset preserve the last demand's row", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const first = {},
                    second = {};
                const current = yield* fixture((subset) =>
                    subset === first
                        ? snapshot({ id: "shared", value: "First" }, { id: "first", value: "First only" })
                        : snapshot({ id: "shared", value: "Second" }, { id: "second", value: "Second only" })
                );
                yield* Effect.promise(() => current.load(first));
                yield* Effect.promise(() => current.ready(first));
                yield* Effect.promise(() => current.load(second));
                yield* Effect.promise(() => current.ready(second));
                expect(current.source.get("shared")?.value).toBe("Second");
                current.publish(first, {
                    reset: false,
                    rows: [{ key: "shared", value: { id: "shared", value: "Updated first" } }],
                    removed: [],
                });
                current.unload(second);
                yield* Effect.promise(() =>
                    vi.waitFor(() => {
                        expect(current.source.get("shared")?.value).toBe("Updated first");
                        expect(current.source.has("second")).toBe(false);
                    })
                );
                current.publish(first, snapshot({ id: "replacement", value: "Replacement" }));
                yield* Effect.promise(() =>
                    vi.waitFor(() =>
                        expect(current.values()).toEqual([{ id: "replacement", value: "Replacement" }])
                    )
                );
                current.publish(first, { reset: false, rows: [], removed: ["replacement"] });
                yield* Effect.promise(() => vi.waitFor(() => expect(current.source.size).toBe(0)));
            })
        )
    );
});

test("a new demand interval reconciles retained rows after every first snapshot arrives", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const old = {},
                    first = {},
                    second = {};
                const current = yield* fixture((subset) =>
                    subset === old ? snapshot({ id: "old", value: "Retained" }) : undefined
                );
                yield* Effect.promise(() => current.load(old));
                yield* Effect.promise(() => current.ready(old));
                current.unload(old);
                expect(current.source.get("old")?.value).toBe("Retained");
                const loadingFirst = current.load(first),
                    loadingSecond = current.load(second);
                yield* Effect.promise(() => current.observing(first));
                yield* Effect.promise(() => current.observing(second));
                current.publish(first, snapshot({ id: "first", value: "New" }));
                yield* Effect.promise(() => current.ready(first));
                expect(current.source.has("old")).toBe(true);
                current.publish(second, snapshot());
                yield* Effect.promise(() => Promise.all([loadingFirst, loadingSecond]));
                yield* Effect.promise(() => current.ready(second));
                expect(current.values()).toEqual([{ id: "first", value: "New" }]);
            })
        )
    );
});

test("batches arriving during a held publication keep their dirty keys for the next commit", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const subset = {},
                    second = {};
                let release!: () => void;
                let holding = false;
                const held = new Promise<void>((resolve) => {
                    release = resolve;
                });
                const current = yield* fixture(
                    (scope) => (scope === subset ? snapshot({ id: "one", value: "Initial" }) : snapshot()),
                    () => {
                        if (!holding) return;
                        holding = false;
                        return held;
                    }
                );
                yield* Effect.addFinalizer(() => Effect.sync(release));
                yield* Effect.promise(() => current.load(subset));
                yield* Effect.promise(() => current.ready(subset));
                yield* Effect.promise(() => current.load(second));
                yield* Effect.promise(() => current.ready(second));
                holding = true;
                current.publish(subset, snapshot({ id: "one", value: "First publication" }));
                yield* Effect.promise(() =>
                    vi.waitFor(() => expect(current.source.get("one")?.value).toBe("First publication"))
                );
                current.publish(second, snapshot({ id: "two", value: "Queued publication" }));
                yield* Effect.promise(() => current.delivered(second, 2));
                release();
                yield* Effect.promise(() =>
                    vi.waitFor(() =>
                        expect(current.values()).toEqual([
                            { id: "one", value: "First publication" },
                            { id: "two", value: "Queued publication" },
                        ])
                    )
                );
            })
        )
    );
});
