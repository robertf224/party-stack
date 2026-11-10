import { BackendError, makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { o } from "@party-stack/ontology-spec";
import { eq, evaluateQuery, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { makeNetworkConnectivity } from "@party-stack/runtime";
import { Deferred, Effect, Exit, Fiber, PubSub, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { makeReplica } from "./testing.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
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
const subset = { objectType: "Item" };
const point = (id: string) => ({ objectType: "Item", query: { where: eq(field("id"), id) } });
const until = <E, R>(predicate: Effect.Effect<boolean, E, R>) =>
    Effect.repeat(Effect.yieldNow, { until: () => predicate }).pipe(Effect.asVoid);
const fixture = Effect.fnUntraced(function* (
    watchSubset: NonNullable<OntologyBackendService["watchSubset"]>,
    settings?: { startSync?: boolean }
) {
    const tables = yield* Memory.make();
    const network = yield* makeNetworkConnectivity(true);
    let values = ["a", "b"].map((id) => ({ key: id, value: { id, value: 0 } }));
    let loads = 0;
    const replica = yield* makeReplica({
        namespace: "watch-acquisition",
        ir,
        tables,
        connectivity: network,
        startSync: settings?.startSync ?? false,
        demand: { idleRetentionMs: 0 },
        objectCacheGc: false,
        execute: () => Effect.void,
        backend: makeOntologyBackend({
            ir,
            name: "watch-test",
            sourceId: "watch-test",
            supportsIdempotency: false,
            applyAction: () => Effect.die("Unexpected action"),
            queryFunction: () => Effect.void,
            watchSubset,
            loadSubset: (request) =>
                Effect.gen(function* () {
                    const compiled = yield* compileObjectSubset(ir, request);
                    loads++;
                    return {
                        rows: evaluateQuery(values, compiled.query),
                        complete: true,
                    };
                }),
        }),
    });
    return {
        replica,
        tables,
        network,
        get loads() {
            return loads;
        },
        edit(value: number) {
            values = values.map((row) => ({ ...row, value: { ...row.value, value } }));
        },
    };
});

test("fresh reads wait for actual watch acquisition while demand and unrelated sync remain usable", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const opening = yield* Deferred.make<void>();
                const release = yield* Deferred.make<void>();
                const f = yield* fixture((request) =>
                    Effect.gen(function* () {
                        if (request.where && JSON.stringify(request.where).includes('"a"')) {
                            yield* Deferred.succeed(opening, undefined);
                            yield* Deferred.await(release);
                        }
                        return Stream.never;
                    })
                );
                yield* f.replica.demand(point("a"));
                yield* Deferred.await(opening);
                const read = yield* f.replica.syncSubset(point("a")).pipe(Effect.forkScoped);
                // This second demand cannot complete if watch setup owns the publication gate.
                yield* f.replica.demand(point("b"));
                yield* f.replica.syncSubset(point("b"));
                expect(f.loads).toBe(1);
                expect(yield* f.replica.get("Item", "a")).toBeUndefined();
                f.edit(1);
                yield* Deferred.succeed(release, undefined);
                yield* Fiber.join(read);
                expect(f.loads).toBe(2);
                expect(yield* f.replica.get("Item", "a")).toEqual({ id: "a", value: 1 });
            })
        ).pipe(Effect.timeout("2 seconds"))
    );
});

test("an acquired buffered watch observes a mutation before its first snapshot", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const registered = yield* Deferred.make<void>();
                const release = yield* Deferred.make<void>();
                const hints = yield* PubSub.unbounded<void>();
                const f = yield* fixture(
                    () =>
                        Effect.gen(function* () {
                            const subscription = yield* PubSub.subscribe(hints);
                            yield* Deferred.succeed(registered, undefined);
                            yield* Deferred.await(release);
                            return Stream.fromSubscription(subscription);
                        }),
                    { startSync: true }
                );
                yield* f.replica.demand(subset);
                yield* Deferred.await(registered);
                expect(f.loads).toBe(0);
                f.edit(1);
                yield* PubSub.publish(hints, undefined);
                yield* Deferred.succeed(release, undefined);
                yield* f.replica.syncSubset(subset);
                yield* until(f.tables.read((tx) => f.replica.hasCoverage(tx, subset)));
                expect(yield* f.replica.get("Item", "a")).toEqual({ id: "a", value: 1 });
                expect(f.loads).toBe(1);
            })
        ).pipe(Effect.timeout("2 seconds"))
    );
});

test("warm coverage and offline local reads do not wait for a newly opening watch", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const opening = yield* Deferred.make<void>();
                const release = yield* Deferred.make<void>();
                let attempt = 0;
                const f = yield* fixture(() =>
                    ++attempt === 1
                        ? Effect.succeed(Stream.never)
                        : Effect.gen(function* () {
                              yield* Deferred.succeed(opening, undefined);
                              yield* Deferred.await(release);
                              return Stream.never;
                          })
                );
                yield* f.replica.demand(subset);
                yield* f.replica.syncSubset(subset);
                yield* f.replica.demand(point("a"));
                yield* Deferred.await(opening);
                yield* f.replica.syncSubset(point("a"));
                expect(f.loads).toBe(1);
                yield* f.network.set(false);
                yield* f.replica.demand(point("missing"));
                yield* f.replica.syncSubset(point("missing"));
                expect(f.loads).toBe(1);
                expect(yield* f.replica.get("Item", "a")).toEqual({ id: "a", value: 0 });
            })
        ).pipe(Effect.timeout("2 seconds"))
    );
});

test("releasing demand interrupts watch acquisition and wakes a waiting fresh read", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const opening = yield* Deferred.make<void>();
                const closed = yield* Deferred.make<void>();
                const f = yield* fixture(() =>
                    Effect.gen(function* () {
                        yield* Effect.acquireRelease(Deferred.succeed(opening, undefined), () =>
                            Deferred.succeed(closed, undefined)
                        );
                        return yield* Effect.never;
                    })
                );
                const owner = yield* Scope.make();
                yield* f.replica.demand(subset).pipe(Scope.provide(owner));
                yield* Deferred.await(opening);
                const read = yield* f.replica.syncSubset(subset).pipe(Effect.forkScoped);
                yield* Scope.close(owner, Exit.void);
                yield* Deferred.await(closed);
                yield* Fiber.join(read);
                expect(f.loads).toBe(0);
                expect((yield* f.replica.status).demands).toEqual([]);
            })
        ).pipe(Effect.timeout("2 seconds"))
    );
});

test("a failed acquisition permits finite reads and reconnect becomes healthy only after acquisition", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const retrying = yield* Deferred.make<void>();
                const release = yield* Deferred.make<void>();
                let attempt = 0;
                const f = yield* fixture(() =>
                    ++attempt === 1
                        ? Effect.fail(
                              new BackendError({
                                  operation: "watch",
                                  kind: "Unavailable",
                                  retryable: true,
                                  message: "Disconnected",
                              })
                          )
                        : Effect.gen(function* () {
                              yield* Deferred.succeed(retrying, undefined);
                              yield* Deferred.await(release);
                              return Stream.never;
                          })
                );
                yield* f.replica.demand(subset);
                yield* until(
                    f.replica.status.pipe(Effect.map((status) => Boolean(status.demands[0]?.watchError)))
                );
                yield* f.replica.syncSubset(subset);
                expect(f.loads).toBe(1);
                yield* TestClock.adjust(1_000);
                yield* Deferred.await(retrying);
                expect((yield* f.replica.status).demands[0]).toMatchObject({
                    watchers: 0,
                    watchError: { kind: "Unavailable" },
                });
                f.edit(2);
                yield* Deferred.succeed(release, undefined);
                yield* until(
                    f.replica.status.pipe(
                        Effect.map(
                            (status) => status.demands[0]?.watchers === 1 && !status.demands[0]?.watchError
                        )
                    )
                );
                yield* f.replica.syncSubset(subset);
                expect(f.loads).toBe(2);
                expect(yield* f.replica.get("Item", "a")).toEqual({ id: "a", value: 2 });
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});

test("a ready quiet watch needs no first event and makes only one cold load", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture(() => Effect.succeed(Stream.never));
                yield* f.replica.demand(subset);
                yield* f.replica.syncSubset(subset);
                expect(f.loads).toBe(1);
                expect((yield* f.replica.status).demands[0]).toMatchObject({
                    watchers: 1,
                    watchError: undefined,
                });
            })
        ).pipe(Effect.timeout("2 seconds"))
    );
});
