import { Runtime } from "@party-stack/runtime";
import { runtimeFixtureContext, memoryRuntimeFixture } from "@party-stack/runtime/testing";
import { createLiveQueryCollection, eq, inArray, queryOnce, IR } from "@tanstack/db";
import { Effect, Scope, Exit, Stream, Deferred } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { makeLocalCollection, makeReplicatedCollection } from "./collections.js";
import type { ReplicaService } from "@party-stack/ontology-replica";

// ReplicaService values in this file are structural test doubles, not native
// owners. Keep all real infrastructure exports; their revision fence is fixed.
vi.mock("@party-stack/ontology-replica/infrastructure", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@party-stack/ontology-replica/infrastructure")>();
    const { Effect } = await import("effect");
    return { ...actual, readVisibleRevision: () => Effect.succeed(0) };
});

test("an initial replica demand failure rejects the TanStack query instead of returning an empty result", async () => {
    const failure = new Error("Issue access was denied.");
    const scope = Effect.runSync(Scope.make());
    const replica = {
        ir: { objectTypes: [], types: [], actionTypes: [], linkTypes: [], queryFunctionTypes: [] },
        readSubset: () => Effect.succeed([]),
        observeSubset: () => Stream.make({ revision: 0, reset: true, rows: [], removed: [] }),
        demand: { acquire: () => Effect.fail(failure) },
    } as unknown as ReplicaService;
    try {
        const collection = await Effect.runPromise(
            Scope.provide(
                makeReplicatedCollection<{ id: string }>({
                    id: "failed-remote-demand",
                    objectType: "Issue",
                    replica,
                    getKey: (row) => row.id,
                }),
                scope
            )
        );
        await expect(queryOnce((q) => q.from({ issue: collection }))).rejects.toBe(failure);
    } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void));
    }
});

test("a failed sync keeps ready rows, stops its work and reloads full replacement rows", async () => {
    const { persistedCollectionOptions, scopedCollection } = await import("./collections.js");
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const rejected = yield* Deferred.make<void>();
                const failure = new Error("Source stopped");
                let runs = 0;
                let active = 0;
                const source = yield* scopedCollection(
                    yield* persistedCollectionOptions({
                        id: "reload-full-rows",
                        getKey: (row: { id: string; title: string; extra?: string }) => row.id,
                        changes: Stream.empty,
                        load: Effect.succeed([]),
                        acquireDemand: Effect.acquireRelease(
                            Effect.sync(() => {
                                active++;
                            }),
                            () =>
                                Effect.sync(() => {
                                    active--;
                                })
                        ),
                        observe: () =>
                            Stream.suspend(() => {
                                const first = runs++ === 0;
                                return Stream.concat(
                                    Stream.make({
                                        revision: runs,
                                        reset: true,
                                        rows: [
                                            {
                                                key: "one",
                                                value: first
                                                    ? { id: "one", title: "Old", extra: "removed" }
                                                    : { id: "one", title: "New" },
                                            },
                                        ],
                                        removed: [],
                                    }),
                                    first
                                        ? Stream.unwrap(
                                              Deferred.await(rejected).pipe(Effect.as(Stream.fail(failure)))
                                          )
                                        : Stream.never
                                );
                            }),
                    })
                );
                const query = createLiveQueryCollection({ query: (q) => q.from({ row: source }) });
                const subscription = query.subscribeChanges(() => {});
                yield* Effect.addFinalizer(() =>
                    Effect.promise(async () => {
                        subscription.unsubscribe();
                        await query.cleanup();
                    })
                );
                yield* Effect.promise(() => query.preload());
                expect(query.toArray).toMatchObject([{ title: "Old", extra: "removed" }]);
                yield* Deferred.succeed(rejected, undefined);
                yield* Effect.promise(() =>
                    vi.waitFor(() => {
                        expect(source.health.error?.cause).toBe(failure);
                        expect(active).toBe(0);
                    })
                );
                expect(source.status).toBe("ready");
                expect(query.toArray).toMatchObject([{ title: "Old" }]);
                yield* Effect.promise(() => query.reload());
                yield* Effect.promise(() =>
                    vi.waitFor(() => expect(query.toArray).toMatchObject([{ title: "New" }]))
                );
                expect(query.toArray[0]).not.toHaveProperty("extra");
                expect(source.health.error).toBeNull();
            })
        )
    );
});

test("scoped local collections persist, share one storage runtime, and stop on scope closure", async () => {
    const adapter = memoryRuntimeFixture("test", "effect-local");
    const { runtime } = runtimeFixtureContext(adapter);
    const scope = Effect.runSync(Scope.make());
    const subscriptions: Array<{ unsubscribe(): void }> = [];
    try {
        const first = await runtime.runPromise(
            Scope.provide(
                makeLocalCollection<{ id: string; title: string }, string>({
                    name: "notes",
                    getKey: (note) => note.id,
                }),
                scope
            )
        );
        subscriptions.push(first.subscribeChanges(() => {}, { includeInitialState: true }));
        await queryOnce((q) => q.from({ row: first }));
        await first.insert({ id: "one", title: "Persisted" }).when("settled");
        const second = await runtime.runPromise(
            Scope.provide(
                makeLocalCollection<{ id: string; title: string }, string>({
                    name: "notes",
                    getKey: (note) => note.id,
                }),
                scope
            )
        );
        subscriptions.push(second.subscribeChanges(() => {}, { includeInitialState: true }));
        await queryOnce((q) => q.from({ row: second }));
        expect(second.get("one")?.title).toBe("Persisted");
        await first
            .update("one", (draft) => {
                draft.title = "Updated";
            })
            .when("settled");
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(second.get("one")?.title).toBe("Updated");
        await Effect.runPromise(Scope.close(scope, Exit.void));
        expect(first.status).toBe("cleaned-up");
        expect(second.status).toBe("cleaned-up");
    } finally {
        subscriptions.forEach((subscription) => subscription.unsubscribe());
        await Effect.runPromise(Scope.close(scope, Exit.void));
        await adapter.cleanup?.();
    }
});

test("persisted inspection queries never acquire remote demand", async () => {
    const adapter = memoryRuntimeFixture("test", "inspection");
    const { runtime } = runtimeFixtureContext(adapter);
    let demands = 0;
    const replica = {
        ir: { objectTypes: [], types: [], actionTypes: [], linkTypes: [], queryFunctionTypes: [] },
        readSubset: () => Effect.succeed([{ key: "one", value: { id: "one" } }]),
        observeSubset: () =>
            Stream.make({
                revision: 0,
                reset: true,
                rows: [{ key: "one", value: { id: "one" } }],
                removed: [],
            }),
        demand: {
            acquire: (_subset: unknown, settings?: { localOnly?: boolean }) =>
                Effect.sync(() => {
                    expect(settings?.localOnly).toBe(true);
                    if (!settings?.localOnly) demands++;
                }),
        },
    } as unknown as ReplicaService;
    try {
        await runtime.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    yield* Runtime;
                    const collection = yield* makeReplicatedCollection<{ id: string }>({
                        id: "inspection",
                        objectType: "Note",
                        getKey: (row) => row.id,
                        replica,
                        localOnly: true,
                    });
                    const rows = yield* Effect.promise(() =>
                        queryOnce((q) => q.from({ note: collection }).select(({ note }) => ({ id: note.id })))
                    );
                    expect(rows.map((row) => row.id)).toEqual(["one"]);
                    expect(demands).toBe(0);
                })
            )
        );
    } finally {
        await adapter.cleanup?.();
    }
});

test("cached rows publish while remote readiness is pending, without completing the subset early", async () => {
    const { persistedCollectionOptions, scopedCollection } = await import("./collections.js");
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const requested = yield* Deferred.make<void>();
                const refreshed = yield* Deferred.make<void>();
                const source = yield* scopedCollection(
                    yield* persistedCollectionOptions({
                        id: "cached-before-refresh",
                        getKey: (row: { id: string; title: string }) => row.id,
                        changes: Stream.never,
                        load: Effect.succeed([]),
                        observe: () =>
                            Stream.concat(
                                Stream.make({
                                    revision: 0,
                                    reset: true,
                                    rows: [{ key: "one", value: { id: "one", title: "Cached" } }],
                                    removed: [],
                                }),
                                Stream.never
                            ),
                        acquireDemand: Deferred.succeed(requested, undefined).pipe(
                            Effect.andThen(Deferred.await(refreshed))
                        ),
                    })
                );
                let complete = false;
                const pending = Promise.resolve(source._sync.loadSubset({})).then(() => {
                    complete = true;
                });
                void pending.catch(() => undefined);
                try {
                    yield* Deferred.await(requested);
                    yield* Effect.promise(() =>
                        vi.waitFor(() => expect(source.get("one")?.title).toBe("Cached"))
                    );
                    expect(complete).toBe(false);
                    yield* Deferred.succeed(refreshed, undefined);
                    yield* Effect.promise(() => pending);
                    expect(complete).toBe(true);
                } finally {
                    yield* Deferred.succeed(refreshed, undefined);
                    yield* Effect.promise(() => pending);
                }
            })
        )
    );
});

test("a held complete collection proves filtered absence without new upstream readiness", async () => {
    const { persistedCollectionOptions, scopedCollection } = await import("./collections.js");
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const release = yield* Deferred.make<void>();
                const source = yield* scopedCollection(
                    yield* persistedCollectionOptions({
                        id: "complete-collection-local-filter",
                        getKey: (row: { id: string; kind: string }) => row.id,
                        changes: Stream.never,
                        load: Effect.succeed([]),
                        observe: () =>
                            Stream.concat(
                                Stream.make({
                                    revision: 0,
                                    reset: true,
                                    rows: [{ key: "one", value: { id: "one", kind: "note" } }],
                                    removed: [],
                                }),
                                Stream.never
                            ),
                        acquireDemand: (subset) => (subset.where ? Deferred.await(release) : Effect.void),
                    })
                );
                const all = createLiveQueryCollection({ query: (q) => q.from({ row: source }) });
                const subscription = all.subscribeChanges(() => {});
                try {
                    yield* Effect.promise(() => all.preload());
                    expect(all.toArray).toHaveLength(1);
                    const missing = yield* Effect.promise(() =>
                        queryOnce((q) => q.from({ row: source }).where(({ row }) => eq(row.kind, "missing")))
                    ).pipe(Effect.timeout("1 second"));
                    expect(missing).toEqual([]);
                    expect(yield* Deferred.isDone(release)).toBe(false);
                } finally {
                    yield* Deferred.succeed(release, undefined);
                    subscription.unsubscribe();
                    yield* Effect.promise(() => all.cleanup());
                }
            })
        )
    );
});

test("the synchronous local helper uses owned tables and runtime cleanup closes every collection", async () => {
    const { make } = await import("@party-stack/ontology-storage/memory/tables");
    const { createLocalCollection } = await import("./createLocalCollection.js");
    const { defineRuntimeFixture } = await import("@party-stack/runtime/testing");
    const base = memoryRuntimeFixture("test", "compatibility-local");
    const adapter = defineRuntimeFixture(() => ({ ...base, tables: make() }))("test", "compatibility-local");
    const options = {
        name: "notes",
        runtime: runtimeFixtureContext(adapter).service,
        scope: runtimeFixtureContext(adapter).scope,
        getKey: (note: { id: string; title: string }) => note.id,
    };
    const first = createLocalCollection(options);
    const second = createLocalCollection(options);
    const subscriptions = [first, second].map((collection) =>
        collection.subscribeChanges(() => {}, { includeInitialState: true })
    );
    try {
        await Promise.all([
            queryOnce((q) => q.from({ row: first })),
            queryOnce((q) => q.from({ row: second })),
        ]);
        await first.insert({ id: "one", title: "Stored" }).when("settled");
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(second.get("one")?.title).toBe("Stored");
        await first.cleanup();
        const reopened = createLocalCollection(options);
        await queryOnce((q) => q.from({ row: reopened }));
        expect(reopened.get("one")?.title).toBe("Stored");
        await adapter.cleanup?.();
        expect(second.status).toBe("cleaned-up");
        expect(reopened.status).toBe("cleaned-up");
    } finally {
        subscriptions.forEach((subscription) => subscription.unsubscribe());
        await adapter.cleanup?.();
    }
});

test("creating an on-demand collection performs no storage reads until a query requests data", async () => {
    const { persistedCollectionOptions, scopedCollection } = await import("./collections.js");
    const { Stream } = await import("effect");
    let reads = 0;
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const config = yield* persistedCollectionOptions({
                    id: "lazy-storage",
                    getKey: (row: { id: string }) => row.id,
                    load: Effect.sync(() => {
                        reads++;
                        return [{ key: "one", value: { id: "one" } }];
                    }),
                    changes: Stream.never,
                });
                const collection = yield* scopedCollection(config);
                expect(collection.config.syncMode).toBe("on-demand");
                expect(reads).toBe(0);
                const rows = yield* Effect.promise(() => queryOnce((q) => q.from({ row: collection })));
                expect(rows.map((row) => row.id)).toEqual(["one"]);
                expect(reads).toBeGreaterThan(0);
            })
        )
    );
});

test("a retained live query keeps replica demand warm until TanStack's query GC runs", async () => {
    const { createLiveQueryCollection } = await import("@tanstack/db");
    const { persistedCollectionOptions, scopedCollection } = await import("./collections.js");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    let roots = 0;
    try {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const source = yield* scopedCollection(
                        yield* persistedCollectionOptions({
                            id: "query-gc-source",
                            getKey: (row: { id: string }) => row.id,
                            changes: Stream.never,
                            load: Effect.succeed([{ key: "one", value: { id: "one" } }]),
                            acquireDemand: Effect.acquireRelease(
                                Effect.sync(() => {
                                    roots++;
                                }),
                                () =>
                                    Effect.sync(() => {
                                        roots--;
                                    })
                            ),
                        })
                    );
                    const query = createLiveQueryCollection({
                        query: (q) => q.from({ row: source }),
                        gcTime: 30_000,
                    });
                    yield* Effect.addFinalizer(() => Effect.promise(() => query.cleanup()));
                    const first = query.subscribeChanges(() => {});
                    const loading = query.preload();
                    yield* Effect.promise(async () => {
                        await vi.waitFor(() => expect(query.status).toBe("ready"));
                        await loading;
                    });
                    expect(roots).toBe(1);
                    first.unsubscribe();
                    yield* Effect.promise(() => vi.advanceTimersByTimeAsync(20_000));
                    expect(roots).toBe(1);
                    const second = query.subscribeChanges(() => {});
                    yield* Effect.promise(() => vi.advanceTimersByTimeAsync(20_000));
                    expect(roots).toBe(1);
                    second.unsubscribe();
                    yield* Effect.promise(() => vi.advanceTimersByTimeAsync(30_100));
                    expect(roots).toBe(0);
                })
            )
        );
    } finally {
        vi.useRealTimers();
    }
});

test("known primary-key rows are ready without waiting for another remote acquisition; missing keys still wait", async () => {
    const { persistedCollectionOptions, scopedCollection } = await import("./collections.js");
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const gate = yield* Deferred.make<void>();
                let requested = 0;
                const bootstrap = {
                    where: new IR.Func<boolean>("eq", [
                        new IR.PropRef(["title"]),
                        new IR.Value("Already loaded"),
                    ]),
                };
                const source = yield* scopedCollection(
                    yield* persistedCollectionOptions({
                        id: "known-primary-key",
                        primaryKey: "id",
                        getKey: (row: { id: string; title: string }) => row.id,
                        changes: Stream.never,
                        load: Effect.succeed([]),
                        observe: () =>
                            Stream.concat(
                                Stream.make({
                                    revision: 0,
                                    reset: true,
                                    rows: [{ key: "one", value: { id: "one", title: "Already loaded" } }],
                                    removed: [],
                                }),
                                Stream.never
                            ),
                        acquireDemand: (subset) =>
                            subset.where === bootstrap.where
                                ? Effect.void
                                : Effect.sync(() => requested++).pipe(Effect.andThen(Deferred.await(gate))),
                    })
                );
                // Hold only a filtered region. A complete collection would also
                // prove that a missing key is absent, which is tested above.
                const lease = source.subscribeChanges(() => {});
                yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                        source._sync.unloadSubset(bootstrap);
                        lease.unsubscribe();
                    })
                );
                yield* Effect.promise(() => Promise.resolve(source._sync.loadSubset(bootstrap)));
                const selected = yield* Effect.promise(() =>
                    queryOnce((q) => q.from({ note: source }).where(({ note }) => eq(note.id, "one")))
                );
                expect(selected).toMatchObject([{ title: "Already loaded" }]);
                const included = yield* Effect.promise(() =>
                    queryOnce((q) => q.from({ note: source }).where(({ note }) => inArray(note.id, ["one"])))
                );
                expect(included).toHaveLength(1);
                let complete = false;
                const absent = queryOnce((q) =>
                    q.from({ note: source }).where(({ note }) => eq(note.id, "missing"))
                ).then((rows) => {
                    complete = true;
                    return rows;
                });
                yield* Effect.promise(() => vi.waitFor(() => expect(requested).toBeGreaterThan(0)));
                expect(complete).toBe(false);
                yield* Deferred.succeed(gate, undefined);
                expect(yield* Effect.promise(() => absent)).toEqual([]);
            })
        )
    );
});

test.each([true, false])(
    "a synchronous first snapshot proves a positive key, never absence (present: %s)",
    async (present) => {
        const { persistedCollectionOptions, scopedCollection } = await import("./collections.js");
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const gate = yield* Deferred.make<void, Error>();
                    const source = yield* scopedCollection(
                        yield* persistedCollectionOptions({
                            id: "first-snapshot-point",
                            primaryKey: "id",
                            getKey: (row: { id: string }) => row.id,
                            changes: Stream.never,
                            load: Effect.succeed([]),
                            observe: () =>
                                Stream.concat(
                                    Stream.make({
                                        revision: 0,
                                        reset: true,
                                        rows: present ? [{ key: "one", value: { id: "one" } }] : [],
                                        removed: [],
                                    }),
                                    Stream.never
                                ),
                            acquireDemand: Deferred.await(gate),
                        })
                    );
                    const result = source._sync.loadSubset({
                        where: new IR.Func<boolean>("eq", [new IR.PropRef(["id"]), new IR.Value("one")]),
                    });
                    expect(result === true).toBe(present);
                    const settled = Promise.resolve(result);
                    void settled.catch(() => undefined);
                    const failure = new Error("Point acquisition failed");
                    yield* Deferred.fail(gate, failure);
                    if (present) {
                        yield* Effect.promise(() =>
                            vi.waitFor(() => expect(source.health.error?.cause).toBe(failure))
                        );
                    } else {
                        yield* Effect.promise(() => expect(settled).rejects.toBe(failure));
                    }
                })
            )
        );
    }
);

test("a cached point read still reports a later acquisition failure", async () => {
    const { persistedCollectionOptions, scopedCollection } = await import("./collections.js");
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const gate = yield* Deferred.make<void, Error>();
                const source = yield* scopedCollection(
                    yield* persistedCollectionOptions({
                        id: "cached-point-failure",
                        primaryKey: "id",
                        getKey: (row: { id: string }) => row.id,
                        changes: Stream.never,
                        load: Effect.succeed([]),
                        observe: () =>
                            Stream.concat(
                                Stream.make({
                                    revision: 0,
                                    reset: true,
                                    rows: [{ key: "one", value: { id: "one" } }],
                                    removed: [],
                                }),
                                Stream.never
                            ),
                        acquireDemand: (subset) => (subset.where ? Deferred.await(gate) : Effect.void),
                    })
                );
                const broad = createLiveQueryCollection((q) => q.from({ row: source }));
                const selected = createLiveQueryCollection((q) =>
                    q.from({ row: source }).where(({ row }) => eq(row.id, "one"))
                );
                const broadLease = broad.subscribeChanges(() => {});
                yield* Effect.promise(() => broad.preload());
                const selectedLease = selected.subscribeChanges(() => {});
                yield* Effect.addFinalizer(() =>
                    Effect.promise(async () => {
                        broadLease.unsubscribe();
                        selectedLease.unsubscribe();
                        await selected.cleanup();
                        await broad.cleanup();
                    })
                );
                yield* Effect.promise(() => selected.preload());
                const failure = new Error("Access revoked");
                yield* Deferred.fail(gate, failure);
                yield* Effect.promise(() =>
                    vi.waitFor(() => expect(source.health.error?.cause).toBe(failure))
                );
            })
        )
    );
});

test("a newly inserted local row completes a pending point read before upstream coverage", async () => {
    const { persistedCollectionOptions, scopedCollection } = await import("./collections.js");
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const inserted = yield* Deferred.make<void>();
                const remote = yield* Deferred.make<void, Error>();
                const source = yield* scopedCollection(
                    yield* persistedCollectionOptions({
                        id: "optimistic-point-read",
                        primaryKey: "id",
                        getKey: (row: { id: string }) => row.id,
                        changes: Stream.never,
                        load: Effect.succeed([]),
                        acquireDemand: Deferred.await(remote),
                        observe: () =>
                            Stream.concat(
                                Stream.make({ revision: 0, reset: true, rows: [], removed: [] }),
                                Stream.concat(
                                    Stream.fromEffect(
                                        Deferred.await(inserted).pipe(
                                            Effect.as({
                                                revision: 1,
                                                reset: false,
                                                rows: [{ key: "new", value: { id: "new" } }],
                                                removed: [],
                                            })
                                        )
                                    ),
                                    Stream.never
                                )
                            ),
                    })
                );
                const query = createLiveQueryCollection((q) =>
                    q.from({ row: source }).where(({ row }) => eq(row.id, "new"))
                );
                const lease = query.subscribeChanges(() => {});
                yield* Effect.addFinalizer(() =>
                    Effect.promise(async () => {
                        lease.unsubscribe();
                        await query.cleanup();
                    })
                );
                let ready = false;
                const loaded = query.preload().then(() => {
                    ready = true;
                });
                yield* Effect.yieldNow;
                expect(ready).toBe(false);
                yield* Deferred.succeed(inserted, undefined);
                yield* Effect.promise(() => vi.waitFor(() => expect(ready).toBe(true)));
                yield* Effect.promise(() => loaded);
                expect(query.toArray).toHaveLength(1);
                expect(query.toArray[0]).toMatchObject({ id: "new" });
                const failure = new Error("Access revoked after local publication");
                yield* Deferred.fail(remote, failure);
                yield* Effect.promise(() =>
                    vi.waitFor(() => expect(source.health.error?.cause).toBe(failure))
                );
            })
        )
    );
});
