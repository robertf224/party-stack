import { it } from "@effect/vitest";
import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { o } from "@party-stack/ontology-spec";
import { eq, evaluateQuery, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { replicaStateSource } from "./parent.js";
import { makeReplica } from "./testing.js";
import type { OntologyIR } from "@party-stack/ontology-spec";

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
                { name: "value", displayName: "Value", type: o.integer({}) },
            ],
        },
    ],
};
const whole = { objectType: "Item" };
const point = { objectType: "Item", query: { where: eq(field("id"), "one") } };

const fixture = Effect.fnUntraced(function* (complete = true) {
    const tables = yield* Memory.make();
    const refreshing = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let value = 1;
    let held = false;
    const backend = makeOntologyBackend({
        ir,
        name: "cached-availability",
        sourceId: "cached-availability",
        supportsIdempotency: false,
        applyAction: () => Effect.die("Unexpected action"),
        queryFunction: () => Effect.void,
        watchSubset: () => Effect.succeed(Stream.never),
        loadSubset: (request) =>
            Effect.gen(function* () {
                if (held) {
                    yield* Deferred.succeed(refreshing, undefined);
                    yield* Deferred.await(release);
                }
                const subset = yield* compileObjectSubset(ir, request);
                return {
                    rows: evaluateQuery([{ key: "one", value: { id: "one", value } }], subset.query),
                    complete,
                };
            }),
    });
    const open = () =>
        makeReplica({
            ir,
            tables,
            backend,
            namespace: "cached-availability",
            startSync: false,
            objectCacheGc: false,
            demand: { refresh: { maxCoverageAgeMs: 0 } },
            execute: () => Effect.void,
        });
    const seedScope = yield* Scope.make();
    const seed = yield* open().pipe(Scope.provide(seedScope));
    yield* seed.demand(whole).pipe(Scope.provide(seedScope));
    yield* seed.syncSubset(whole);
    yield* Scope.close(seedScope, Exit.void);
    held = true;
    value = 2;
    const replica = yield* open();
    return { replica, tables, refreshing, release };
});

it.effect(
    "a retained confirmation survives restart and watch reset without making the fresh read ready",
    () =>
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                yield* f.replica.demand(whole);
                const freshDone = yield* Deferred.make<void>();
                const fresh = yield* f.replica.syncSubset(whole).pipe(
                    Effect.tap(() => Deferred.succeed(freshDone, undefined)),
                    Effect.forkScoped
                );
                yield* Deferred.await(f.refreshing);
                expect(yield* f.tables.read((tx) => f.replica.hasCoverage(tx, whole))).toBe(false);

                // A complete retained collection also witnesses a local filter. No
                // currently present row alone could establish this availability.
                yield* f.replica.syncSubset(point, { resultType: "cached" });
                const missing = { objectType: "Item", query: { where: eq(field("id"), "missing") } };
                yield* f.replica.syncSubset(missing, { resultType: "cached" });
                expect(yield* f.replica.loadSubset("Item", missing.query)).toEqual([]);
                yield* f.replica.syncSubset(whole, { resultType: "cached" });
                expect(yield* f.replica.get("Item", "one")).toEqual({ id: "one", value: 1 });
                expect(yield* Deferred.isDone(freshDone)).toBe(false);
                expect((yield* f.replica.status).demands[0]?.installed).not.toBe(
                    (yield* f.replica.status).demands[0]?.revision
                );

                yield* Deferred.succeed(f.release, undefined);
                yield* Fiber.join(fresh);
                expect(yield* f.replica.get("Item", "one")).toEqual({ id: "one", value: 2 });
                expect(yield* f.tables.read((tx) => f.replica.hasCoverage(tx, whole))).toBe(true);
            })
        )
);

it.effect("present rows from an incomplete snapshot never establish cached readiness", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture(false);
            yield* f.replica.demand(whole);
            const done = yield* Deferred.make<void>();
            const read = yield* f.replica.syncSubset(whole, { resultType: "cached" }).pipe(
                Effect.tap(() => Deferred.succeed(done, undefined)),
                Effect.forkScoped
            );
            yield* Deferred.await(f.refreshing);
            expect(yield* f.replica.get("Item", "one")).toEqual({ id: "one", value: 1 });
            expect(yield* Deferred.isDone(done)).toBe(false);
            yield* Fiber.interrupt(read);
        })
    )
);

it.effect("eviction removes historical cached availability with the retained row", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture();
            yield* TestClock.adjust(1);
            expect(yield* f.replica.collectGarbage({ minUnusedAgeMs: 0 })).toBe(1);
            yield* f.replica.demand(whole);
            const done = yield* Deferred.make<void>();
            const read = yield* f.replica.syncSubset(whole, { resultType: "cached" }).pipe(
                Effect.tap(() => Deferred.succeed(done, undefined)),
                Effect.forkScoped
            );
            yield* Deferred.await(f.refreshing);
            expect(yield* f.replica.get("Item", "one")).toBeUndefined();
            expect(yield* Deferred.isDone(done)).toBe(false);
            yield* Fiber.interrupt(read);
        })
    )
);

it.effect(
    "selected delivery carries cached availability without confirming fresh coverage in the child",
    () =>
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const source = replicaStateSource(f.replica);
                const child = yield* makeReplica({
                    ir,
                    tables: yield* Memory.make(),
                    source,
                    namespace: "cached-child",
                    startSync: true,
                    objectCacheGc: false,
                    execute: () => Effect.void,
                });
                yield* child.demand(whole);
                yield* child.syncSubset(whole, { resultType: "cached" });
                yield* Deferred.await(f.refreshing);
                expect(yield* child.get("Item", "one")).toEqual({ id: "one", value: 1 });
                expect((yield* child.snapshotSubset(whole)).complete).toBe(false);
                const demand = (yield* child.status).demands[0]!;
                expect(demand.installed).not.toBe(demand.revision);
                const freshDone = yield* Deferred.make<void>();
                const fresh = yield* child.syncSubset(whole).pipe(
                    Effect.tap(() => Deferred.succeed(freshDone, undefined)),
                    Effect.forkScoped
                );
                yield* TestClock.adjust(0);
                expect(yield* Deferred.isDone(freshDone)).toBe(false);
                yield* Deferred.succeed(f.release, undefined);
                yield* Fiber.join(fresh);
                expect(yield* child.get("Item", "one")).toEqual({ id: "one", value: 2 });
                expect((yield* child.snapshotSubset(whole)).complete).toBe(true);
            })
        )
);

it.effect("snapshot fallback preserves cached confirmation separately from current completeness", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture();
            const source = { ...replicaStateSource(f.replica), subscribe: undefined };
            const child = yield* makeReplica({
                ir,
                tables: yield* Memory.make(),
                source,
                namespace: "cached-snapshot-child",
                startSync: false,
                objectCacheGc: false,
                execute: () => Effect.void,
            });
            const session = yield* f.replica.openClient();
            const state = yield* f.replica.readClient(session, {
                generation: 1,
                selection: { subsets: [whole], actionIds: [] },
            });
            expect(state.coverage).toEqual([{ subset: whole, complete: false, cached: true }]);
            yield* child.receiveParentState(state.state, [], state.coverage);
            yield* child.syncSubset(whole, { resultType: "cached" });
            expect(yield* child.get("Item", "one")).toEqual({ id: "one", value: 1 });
            expect((yield* child.snapshotSubset(whole)).complete).toBe(false);
        })
    )
);
