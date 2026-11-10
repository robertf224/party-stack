import { BackendError, makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset, objectSubset } from "@party-stack/ontology-backend/subset";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { evaluateQuery, field, eq, gte, lte } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Effect, Fiber, Queue, Stream } from "effect";
import { expect, test } from "vitest";
import { makeReplica } from "./testing.js";
import type { SubsetWatchEvent } from "@party-stack/ontology-backend";
import type { CompiledSubset } from "@party-stack/ontology-backend/subset";

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
                { name: "rank", displayName: "Rank", type: o.integer({}) },
            ],
        },
    ],
};
const a = {
    objectType: "Item",
    query: { where: lte(field("rank"), 10), orderBy: [{ field: field("rank") }], limit: 3 },
};
const b = { objectType: "Item", query: { where: gte(field("rank"), 40) } };
const whole = { objectType: "Item" };
const point = { objectType: "Item", query: { where: eq(field("id"), "row-0") } };
type Message = { event: SubsetWatchEvent; handled: Deferred.Deferred<void>; failure?: BackendError };
type Watch = { queue: Queue.Queue<Message> };
const canonical = (value: unknown): unknown =>
    Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === "object"
          ? Object.fromEntries(
                Object.entries(value)
                    .filter(([, item]) => item !== undefined)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([key, item]) => [key, canonical(item)])
            )
          : value;
const same = (left: CompiledSubset, right: CompiledSubset) =>
    left.objectType === right.objectType &&
    left.query?.limit === right.query?.limit &&
    JSON.stringify(canonical(left.query?.where)) === JSON.stringify(canonical(right.query?.where));
const fixture = Effect.fnUntraced(function* (pollWhole = false) {
    const storage = yield* Memory.make();
    const registrations = yield* Queue.unbounded<Watch>();
    const loaded = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const checked = yield* Deferred.make<void>();
    const resumeCheck = yield* Deferred.make<void>();
    let holdB = false,
        pauseCheck = false;
    let values = Array.from({ length: 100 }, (_, rank) => ({
        key: `row-${rank}`,
        value: { id: `row-${rank}`, rank },
    }));
    const loads: CompiledSubset[] = [];
    const expected = new Map(
        yield* Effect.forEach([a, b, whole, point] as CompiledSubset[], (subset) =>
            compileObjectSubset(ir, objectSubset(subset.objectType, subset.query)).pipe(
                Effect.map((compiled) => [subset, compiled] as const)
            )
        )
    );
    const matches = (left: CompiledSubset, right: CompiledSubset) => same(left, expected.get(right) ?? right);
    const replica = yield* makeReplica({
        namespace: "reset-scope",
        ir,
        startSync: false,
        objectCacheGc: false,
        execute: () => Effect.void,
        tables: {
            ...storage,
            read: (body) =>
                Effect.gen(function* () {
                    let pause = false;
                    const value = yield* storage.read((tx) =>
                        body({
                            ...tx,
                            query: new Proxy(tx.query, {
                                apply(target, thisArg, args) {
                                    const [table] = args as Parameters<typeof tx.query>;
                                    if (pauseCheck && "name" in table && table.name.endsWith('"coverage"]')) {
                                        pauseCheck = false;
                                        pause = true;
                                    }
                                    return Reflect.apply(target, thisArg, args);
                                },
                            }),
                        })
                    );
                    if (pause) {
                        yield* Deferred.succeed(checked, undefined);
                        yield* Deferred.await(resumeCheck);
                    }
                    return value;
                }),
        },
        backend: makeOntologyBackend({
            ir,
            name: "watch-only",
            sourceId: "watch-only",
            supportsIdempotency: false,
            applyAction: () => Effect.die("Unexpected action"),
            queryFunction: () => Effect.void,
            refresh: () => ({ pollIntervalMs: 60_000 }),
            watchSubset: (request) =>
                pollWhole && !request.where
                    ? undefined
                    : Effect.gen(function* () {
                          const queue = yield* Queue.unbounded<Message>();
                          yield* Queue.offer(registrations, { queue });
                          return Stream.fromQueue(queue).pipe(
                              Stream.flatMap(({ event, handled, failure }) =>
                                  failure
                                      ? Stream.fail(failure)
                                      : Stream.concat(
                                            Stream.succeed(event),
                                            Stream.fromEffect(Deferred.succeed(handled, undefined)).pipe(
                                                Stream.drain
                                            )
                                        )
                              )
                          );
                      }),
            loadSubset: (request) =>
                Effect.gen(function* () {
                    const subset = yield* compileObjectSubset(ir, request);
                    loads.push(subset);
                    const rows = evaluateQuery(values, subset.query);
                    if (holdB && matches(subset, b)) {
                        holdB = false;
                        yield* Deferred.succeed(loaded, undefined);
                        yield* Deferred.await(release);
                    }
                    return { rows, complete: true };
                }),
        }),
    });
    const hint = (watch: Watch, event: SubsetWatchEvent) =>
        Effect.gen(function* () {
            const handled = yield* Deferred.make<void>();
            yield* Queue.offer(watch.queue, { event, handled });
            yield* Deferred.await(handled);
        });
    return {
        replica,
        storage,
        loads,
        matches,
        registrations,
        hint,
        loaded,
        release,
        checked,
        resumeCheck,
        hold: () => {
            holdB = true;
        },
        pause: () => {
            pauseCheck = true;
        },
        edit: (id: string, rank: number) => {
            values = values.map((row) => (row.key === id ? { key: id, value: { id, rank } } : row));
        },
    };
});

test("a new disjoint reset preserves the healthy top-k proof while fencing its own old cold load", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                yield* f.replica.demand(a);
                const aw = yield* Queue.take(f.registrations);
                yield* f.hint(aw, "reset");
                yield* f.replica.syncSubset(a);
                expect(
                    f.loads.filter((subset) => f.matches(subset, a)),
                    JSON.stringify(f.loads)
                ).toHaveLength(1);
                yield* f.replica.demand(b);
                const bw = yield* Queue.take(f.registrations);
                f.hold();
                const loading = yield* f.replica.syncSubset(b).pipe(Effect.forkScoped);
                yield* Deferred.await(f.loaded);
                f.edit("row-40", 900);
                yield* f.hint(bw, "reset");
                expect(yield* f.storage.read((tx) => f.replica.hasCoverage(tx, a))).toBe(true);
                yield* Deferred.succeed(f.release, undefined);
                yield* Fiber.join(loading);
                expect(yield* f.storage.read((tx) => f.replica.hasCoverage(tx, b))).toBe(false);
                yield* f.replica.syncSubset(b);
                expect((yield* f.replica.get("Item", "row-40"))?.rank).toBe(900);
                expect(f.loads.filter((subset) => f.matches(subset, a))).toHaveLength(1);
                expect(f.loads.filter((subset) => f.matches(subset, b))).toHaveLength(2);
            })
        )
    );
});

test("another watch real invalidation fences a previously read proof even without changing its owner revision", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                yield* f.replica.demand(whole);
                const broad = yield* Queue.take(f.registrations);
                yield* f.hint(broad, "reset");
                yield* f.replica.syncSubset(whole);
                yield* f.replica.demand(point);
                const narrow = yield* Queue.take(f.registrations);
                yield* f.hint(narrow, "reset");
                yield* f.replica.syncSubset(point);
                const before = (yield* f.replica.status).demands.find(
                    (demand) => !demand.query?.where
                )!.revision;
                f.pause();
                const checking = yield* f.replica.syncOnce.pipe(Effect.forkScoped);
                yield* Deferred.await(f.checked);
                f.edit("row-50", 900);
                yield* f.hint(narrow, undefined);
                expect(
                    (yield* f.replica.status).demands.find((demand) => !demand.query?.where)!.revision
                ).toBe(before);
                yield* Deferred.succeed(f.resumeCheck, undefined);
                yield* Fiber.join(checking);
                expect((yield* f.replica.get("Item", "row-50"))?.rank).toBe(900);
                expect(f.loads.filter((subset) => f.matches(subset, whole))).toHaveLength(2);
            })
        )
    );
});

test("a polling-only whole-collection proof is not protected by a new point-watch reset", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture(true);
                yield* f.replica.demand(whole);
                yield* f.replica.syncSubset(whole);
                expect(yield* f.storage.read((tx) => f.replica.hasCoverage(tx, whole))).toBe(true);
                yield* f.replica.demand(point);
                const narrow = yield* Queue.take(f.registrations);
                f.edit("row-0", 900);
                yield* f.hint(narrow, "reset");
                expect(yield* f.storage.read((tx) => f.replica.hasCoverage(tx, whole))).toBe(false);
                yield* f.replica.syncSubset(point);
                expect((yield* f.replica.get("Item", "row-0"))?.rank).toBe(900);
            })
        )
    );
});

test("a failed whole-collection watcher cannot protect its prior coverage", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                yield* f.replica.demand(whole);
                const broad = yield* Queue.take(f.registrations);
                yield* f.hint(broad, "reset");
                yield* f.replica.syncSubset(whole);
                yield* Queue.offer(broad.queue, {
                    event: undefined,
                    handled: yield* Deferred.make<void>(),
                    failure: new BackendError({
                        operation: "test",
                        kind: "Forbidden",
                        retryable: false,
                        message: "Stopped",
                    }),
                });
                while (!(yield* f.replica.status).demands.find((demand) => !demand.query?.where)?.watchError)
                    yield* Effect.yieldNow;
                yield* f.replica.demand(point);
                const narrow = yield* Queue.take(f.registrations);
                f.edit("row-0", 900);
                yield* f.hint(narrow, "reset");
                expect(yield* f.storage.read((tx) => f.replica.hasCoverage(tx, whole))).toBe(false);
            }).pipe(Effect.timeout("2 seconds"))
        )
    );
});
