import { Runtime } from "@party-stack/runtime";
import { runtimeFixtureContext, memoryRuntimeFixture } from "@party-stack/runtime/testing";
import { queryOnce } from "@tanstack/db";
import { Effect, Scope, Exit, Stream } from "effect";
import { expect, test } from "vite-plus/test";
import { makeLocalCollection, makeReplicatedCollection } from "./collections.js";
import type { ReplicaService } from "@party-stack/ontology-replica";

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
        await first.insert({ id: "one", title: "Persisted" }).isPersisted.promise;
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
        await first.update("one", (draft) => {
            draft.title = "Updated";
        }).isPersisted.promise;
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
        loadSubset: () => Effect.succeed([{ key: "one", value: { id: "one" } }]),
        observeRows: () =>
            Stream.make({ reset: true, rows: [{ key: "one", value: { id: "one" } }], removed: [] }),
        retainLocal: () => Effect.void,
        demand: () =>
            Effect.sync(() => {
                demands++;
            }),
        changes: Stream.never,
        subscribeChanges: Effect.succeed(Stream.never),
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
                        persistedOnly: true,
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

test("the synchronous local helper uses owned tables and runtime cleanup closes every collection", async () => {
    const { make } = await import("@party-stack/ontology-storage/memory/tables");
    const { createLocalCollection } = await import("./createLocalCollection.js");
    const { defineRuntimeFixture } = await import("@party-stack/runtime/testing");
    const base = memoryRuntimeFixture("test", "compatibility-local");
    const adapter = defineRuntimeFixture(() => ({ ...base, tables: make() }))("test", "compatibility-local");
    const options = {
        name: "notes",
        runtime: adapter,
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
        await first.insert({ id: "one", title: "Stored" }).isPersisted.promise;
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
