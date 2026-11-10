import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset, objectSubset } from "@party-stack/ontology-backend/subset";
import { makeReplica } from "@party-stack/ontology-replica";
import { o } from "@party-stack/ontology-spec";
import { evaluateQuery, eq, field } from "@party-stack/ontology-storage";
import { Runtime } from "@party-stack/runtime";
import { memoryRuntimeFixture, runtimeFixtureContext } from "@party-stack/runtime/testing";
import { createLiveQueryCollection } from "@tanstack/db";
import { Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { makeReplicatedCollection } from "./collections.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { ObjectSubset } from "@party-stack/ontology-spec/query";

interface Item {
    id: string;
    title: string;
}
const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
            ],
        },
    ],
};
const values = (rows: readonly Item[]) => rows.map(({ id, title }) => ({ id, title }));
const all = objectSubset("Item");
const one = objectSubset("Item", { where: eq(field("id"), "one") });
const fixture = Effect.fnUntraced(function* (name: string, initial: ObjectSubset) {
    const runtime = memoryRuntimeFixture("cached-availability", name);
    yield* Effect.addFinalizer(() => Effect.promise(() => runtime.cleanup()));
    const platform = runtimeFixtureContext(runtime).service;
    const requested = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let held = false;
    let loads = 0;
    let rows = [
        { key: "one", value: { id: "one", title: "Cached" } },
        { key: "two", value: { id: "two", title: "Other" } },
    ];
    const backend = makeOntologyBackend({
        ir,
        name: "availability",
        sourceId: "availability",
        supportsIdempotency: false,
        applyAction: () => Effect.die("Unexpected action"),
        queryFunction: () => Effect.void,
        watchSubset: () => Effect.succeed(Stream.never),
        loadSubset: (request) =>
            Effect.gen(function* () {
                loads++;
                if (held) {
                    yield* Deferred.succeed(requested, undefined);
                    yield* Deferred.await(release);
                }
                const scan = yield* compileObjectSubset(ir, request);
                return { rows: evaluateQuery(rows, scan.query), complete: true };
            }),
    });
    const open = (scope: Scope.Scope) =>
        Scope.provide(
            makeReplica({
                ir,
                backend,
                id: name,
                cache: { objects: false, attachments: false },
                demand: { idleRetentionMs: 0 },
            }).pipe(Effect.provideService(Runtime, platform)),
            scope
        );
    const firstScope = yield* Scope.fork(yield* Effect.scope);
    const first = yield* open(firstScope);
    yield* first.demand.acquire(initial, { resultType: "complete" }).pipe(Scope.provide(firstScope));
    yield* Scope.close(firstScope, Exit.void);
    // The second owner must establish fresh coverage; only the persisted
    // previously complete region may satisfy cache-first readiness meanwhile.
    rows = rows.map((row) => (row.key === "one" ? { ...row, value: { ...row.value, title: "Fresh" } } : row));
    held = true;
    const replica = yield* open(yield* Effect.scope);
    return {
        replica,
        requested,
        release,
        get loads() {
            return loads;
        },
    };
});

const liveItems = Effect.fnUntraced(function* (
    replica: Effect.Success<ReturnType<typeof fixture>>["replica"],
    id: string
) {
    const source = yield* makeReplicatedCollection<Item>({
        id,
        objectType: "Item",
        replica,
        getKey: (row) => row.id,
    });
    const query = createLiveQueryCollection({ query: (q) => q.from({ item: source }) });
    const subscription = query.subscribeChanges(() => {});
    yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
            subscription.unsubscribe();
            await query.cleanup();
        })
    );
    return { source, query };
});

test("previously complete cached availability readies native and TanStack demand while fresh refresh remains blocked", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture("complete-region", all);
                const cachedReady = yield* Deferred.make<void>();
                const cached = yield* f.replica.demand
                    .acquire(all)
                    .pipe(Effect.andThen(Deferred.succeed(cachedReady, undefined)), Effect.forkScoped);
                yield* Deferred.await(f.requested);
                // These must finish while the real backend read is still waiting.
                yield* Deferred.await(cachedReady).pipe(Effect.timeout("1 second"));
                yield* Fiber.join(cached);
                const { query } = yield* liveItems(f.replica, "cached-region-query");
                yield* Effect.promise(() => query.preload()).pipe(Effect.timeout("1 second"));
                expect(values(query.toArray)).toEqual([
                    { id: "one", title: "Cached" },
                    { id: "two", title: "Other" },
                ]);
                expect(yield* Deferred.isDone(f.release)).toBe(false);
                const completeReady = yield* Deferred.make<void>();
                const complete = yield* f.replica.demand
                    .acquire(all, { resultType: "complete" })
                    .pipe(Effect.andThen(Deferred.succeed(completeReady, undefined)), Effect.forkScoped);
                yield* Effect.yieldNow;
                expect(yield* Deferred.isDone(completeReady)).toBe(false);
                yield* Deferred.succeed(f.release, undefined);
                yield* Fiber.join(complete);
                yield* Effect.promise(() =>
                    vi.waitFor(() =>
                        expect(values(query.toArray)).toEqual([
                            { id: "one", title: "Fresh" },
                            { id: "two", title: "Other" },
                        ])
                    )
                );
                expect(f.loads).toBeGreaterThanOrEqual(2);
            })
        )
    );
});

test("a cached point does not ready a larger TanStack query without historical coverage of that region", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture("partial-region", one);
                const acquired = yield* Deferred.make<void>();
                const native = yield* f.replica.demand
                    .acquire(all)
                    .pipe(Effect.andThen(Deferred.succeed(acquired, undefined)), Effect.forkScoped);
                const { source, query } = yield* liveItems(f.replica, "partial-region-query");
                let queryReady = false;
                const loading = query.preload().then(() => {
                    queryReady = true;
                });
                void loading.catch(() => undefined);
                yield* Deferred.await(f.requested);
                // The normal live collection can publish its one installed row, but
                // that row is not a complete answer for the larger requested region.
                yield* Effect.promise(() =>
                    vi.waitFor(() => expect(values(source.toArray)).toEqual([{ id: "one", title: "Cached" }]))
                );
                expect(yield* Deferred.isDone(acquired)).toBe(false);
                expect(queryReady).toBe(false);
                yield* Deferred.succeed(f.release, undefined);
                yield* Fiber.join(native);
                yield* Effect.promise(() => loading);
                expect(values(query.toArray)).toEqual([
                    { id: "one", title: "Fresh" },
                    { id: "two", title: "Other" },
                ]);
            })
        )
    );
});
