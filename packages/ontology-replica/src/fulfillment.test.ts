import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { BackendError } from "@party-stack/ontology-backend";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { o } from "@party-stack/ontology-spec";
import { eq, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { createTraceCapture } from "@party-stack/runtime/tracing";
import { Deferred, Effect, PubSub, Scope, Exit, Stream, Tracer, Fiber } from "effect";
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
            name: "Issue",
            displayName: "Issue",
            pluralDisplayName: "Issues",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "rank", displayName: "Rank", type: o.integer({}) },
            ],
        },
    ],
};
const rows = Array.from({ length: 40 }, (_, rank) => ({ key: `i${rank}`, value: { id: `i${rank}`, rank } }));
const selected = {
    objectType: "Issue",
    query: { orderBy: [{ field: field("rank"), direction: "asc" as const }], limit: 5 },
};

test("a selected view synchronizes its subsets in one pass without inheriting unrelated failures", async () => {
    const trace = createTraceCapture();
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const replica = yield* makeReplica({
                    namespace: "selection-sync",
                    ir,
                    tables: yield* Memory.make(),
                    execute: () => Effect.void,
                    startSync: false,
                    backend: makeOntologyBackend({
                        ir,
                        name: "test",
                        sourceId: "test",
                        supportsIdempotency: false,
                        applyAction: () => Effect.die("Unexpected action"),
                        queryFunction: () => Effect.void,
                        loadSubset: (subset) =>
                            subset.where
                                ? Effect.succeed({ rows, complete: true })
                                : Effect.fail(
                                      new BackendError({
                                          operation: "loadSubset",
                                          kind: "Forbidden",
                                          retryable: false,
                                          message: "Denied",
                                      })
                                  ),
                    }),
                });
                const denied = { objectType: "Issue", query: {} };
                yield* replica.demand(denied);
                expect((yield* Effect.result(replica.syncSubset(denied)))._tag).toBe("Failure");
                trace.clear();
                const subsets = [0, 1, 2].map((index) => ({
                    objectType: "Issue",
                    query: { where: eq(field("id"), `i${index}`) },
                }));
                yield* replica.subscribeSelection({ subsets, actionIds: [] });
                for (const index of [0, 1, 2])
                    expect((yield* replica.get("Issue", `i${index}`))?.rank).toBe(index);
                expect(trace.getSnapshot().filter((span) => span.name === "Replica.sync")).toHaveLength(1);
            })
        ).pipe(Effect.provideService(Tracer.Tracer, trace.tracer))
    );
});

test("complete collection coverage checks do not reread every demanded object", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const storage = yield* Memory.make();
                let objectReads = 0;
                let loads = 0;
                const replica = yield* makeReplica({
                    namespace: "coverage-reads",
                    ir,
                    startSync: false,
                    tables: {
                        ...storage,
                        read: (body) =>
                            storage.read((tx) =>
                                body({
                                    ...tx,
                                    get: (table, key) => {
                                        if (
                                            table.name ===
                                            JSON.stringify(["replica", "coverage-reads", "base:Issue"])
                                        )
                                            objectReads++;
                                        return tx.get(table, key);
                                    },
                                })
                            ),
                    },
                    execute: () => Effect.void,
                    backend: makeOntologyBackend({
                        ir,
                        name: "test",
                        sourceId: "test",
                        supportsIdempotency: false,
                        applyAction: () => Effect.die("Unexpected action"),
                        queryFunction: () => Effect.void,
                        loadSubset: () =>
                            Effect.sync(() => {
                                loads++;
                                return { rows, complete: true };
                            }),
                    }),
                });
                yield* replica.demand({ objectType: "Issue" });
                yield* replica.syncOnce;
                for (const id of [...rows.map((row) => row.key), "absent"])
                    yield* replica.demand({ objectType: "Issue", query: { where: eq(field("id"), id) } });
                objectReads = 0;
                yield* replica.syncOnce;
                expect(loads).toBe(1);
                expect(objectReads).toBe(0);
                expect((yield* replica.loadSubset("Issue")).length).toBe(rows.length);
                expect(yield* replica.get("Issue", "absent")).toBeUndefined();
            })
        )
    );
});

for (const [event, retained, broader] of [
    ["reset", true, false],
    ["reset", false, false],
    [undefined, true, false],
    ["reset", true, true],
] as const)
    test(`watch repair reuses only live covering proof (${event}, retained=${retained}, broader=${broader})`, async () => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const started = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
                    let watches = 0;
                    let loads = 0;
                    const storage = yield* Memory.make();
                    const replica = yield* makeReplica({
                        namespace: "watch-repair",
                        ir,
                        tables: storage,
                        execute: () => Effect.void,
                        startSync: false,
                        storeBroaderSubsets: true,
                        demand: { idleRetentionMs: 0 },
                        backend: makeOntologyBackend({
                            ir,
                            name: "test",
                            sourceId: "test",
                            supportsIdempotency: false,
                            applyAction: () => Effect.die("Unexpected action"),
                            queryFunction: () => Effect.void,
                            watchSubset: () => {
                                const index = watches++;
                                // The marker runs after the replica has handled the
                                // boundary; the watch stays open for coverage reuse.
                                return Effect.succeed(
                                    Stream.concat(
                                        Stream.make(index === 0 ? "reset" : event),
                                        Stream.fromEffect(Deferred.succeed(started[index]!, undefined)).pipe(
                                            Stream.drain,
                                            Stream.concat(Stream.never)
                                        )
                                    )
                                );
                            },
                            loadSubset: () =>
                                Effect.sync(() => {
                                    loads++;
                                    return { rows, complete: true, fulfilledSubset: objectSubset("Issue") };
                                }),
                        }),
                    });
                    const first = broader ? selected : { objectType: "Issue", query: {} };
                    const second = broader ? { objectType: "Issue", query: {} } : selected;
                    const coveringScope = yield* Scope.make();
                    yield* replica.demand(first).pipe(Scope.provide(coveringScope));
                    yield* Deferred.await(started[0]!);
                    yield* replica.syncSubset(first);
                    expect(loads).toBe(1);
                    if (!retained) yield* Scope.close(coveringScope, Exit.void);
                    yield* replica.demand(second);
                    yield* Deferred.await(started[1]!);
                    expect(yield* storage.read((tx) => replica.hasCoverage(tx, second))).toBe(
                        event === "reset" && retained && !broader
                    );
                    yield* replica.syncSubset(second);
                    expect(loads).toBe(event === "reset" && retained && !broader ? 1 : 2);
                    if (retained) yield* Scope.close(coveringScope, Exit.void);
                })
            )
        );
    });

for (const event of ["reset", undefined] as const)
    test(`a concurrent watch ${event ?? "invalidation"} preserves only a current covering check`, async () => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const checked = yield* Deferred.make<void>();
                    const resume = yield* Deferred.make<void>();
                    const hint = yield* Deferred.make<void>();
                    const handled = yield* Deferred.make<void>();
                    const storage = yield* Memory.make();
                    let armed = false;
                    let loads = 0;
                    let windowLoads = 0;
                    let watches = 0;
                    let current = rows;
                    const replica = yield* makeReplica({
                        namespace: "watch-check-race",
                        ir,
                        startSync: false,
                        execute: () => Effect.void,
                        tables: {
                            ...storage,
                            read: (body) =>
                                Effect.gen(function* () {
                                    let pause = false;
                                    const result = yield* storage.read((tx) =>
                                        body({
                                            ...tx,
                                            query: new Proxy(tx.query, {
                                                apply(target, thisArg, args) {
                                                    const [table] = args as Parameters<typeof tx.query>;
                                                    if (
                                                        armed &&
                                                        "name" in table &&
                                                        table.name ===
                                                            JSON.stringify([
                                                                "replica",
                                                                "watch-check-race",
                                                                "coverage",
                                                            ])
                                                    ) {
                                                        armed = false;
                                                        pause = true;
                                                    }
                                                    return Reflect.apply(target, thisArg, args);
                                                },
                                            }),
                                        })
                                    );
                                    // The check has captured its proof/revision, but its caller
                                    // has not consumed them. Release storage so the watch can run.
                                    if (pause) {
                                        yield* Deferred.succeed(checked, undefined);
                                        yield* Deferred.await(resume);
                                    }
                                    return result;
                                }),
                        },
                        backend: makeOntologyBackend({
                            ir,
                            name: "test",
                            sourceId: "test",
                            supportsIdempotency: false,
                            applyAction: () => Effect.die("Unexpected action"),
                            queryFunction: () => Effect.void,
                            watchSubset: () =>
                                Effect.succeed(
                                    watches++ === 0
                                        ? Stream.never
                                        : Stream.concat(
                                              Stream.fromEffect(Deferred.await(hint)).pipe(Stream.as(event)),
                                              Stream.fromEffect(Deferred.succeed(handled, undefined)).pipe(
                                                  Stream.drain,
                                                  Stream.concat(Stream.never)
                                              )
                                          )
                                ),
                            loadSubset: (request) =>
                                Effect.sync(() => {
                                    loads++;
                                    if (request.page?.limit === selected.query.limit) windowLoads++;
                                    return {
                                        rows: current,
                                        complete: true,
                                        fulfilledSubset: objectSubset("Issue"),
                                    };
                                }),
                        }),
                    });
                    const all = { objectType: "Issue", query: {} };
                    yield* replica.demand(all);
                    yield* replica.syncSubset(all);
                    expect(loads).toBe(1);
                    yield* replica.demand(selected);
                    armed = true;
                    const sync = yield* replica.syncSubset(selected).pipe(Effect.forkScoped);
                    yield* Deferred.await(checked);
                    if (event !== "reset")
                        current = rows.map((row) =>
                            row.key === "i0" ? { ...row, value: { ...row.value, rank: 99 } } : row
                        );
                    yield* Deferred.succeed(hint, undefined);
                    yield* Deferred.await(handled);
                    yield* Deferred.succeed(resume, undefined);
                    yield* Fiber.join(sync);
                    // Real invalidation also fences the other watch's captured
                    // full-collection check. Refresh it once, then reuse that
                    // fresh proof for the window; reset retains the healthy proof.
                    expect(loads).toBe(event === "reset" ? 1 : 2);
                    expect(windowLoads).toBe(0);
                    expect(
                        (yield* replica.loadSubset("Issue", selected.query)).map((row) => row.key)
                    ).toEqual(
                        event === "reset" ? ["i0", "i1", "i2", "i3", "i4"] : ["i1", "i2", "i3", "i4", "i5"]
                    );
                })
            )
        );
    });

for (const storeBroaderSubsets of [undefined, false, true])
    test(`broader snapshots retain extra objects only with explicit opt-in (${storeBroaderSubsets})`, async () => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    let loads = 0;
                    const backend: OntologyBackendService = makeOntologyBackend({
                        ir,
                        name: "test",
                        sourceId: "test",
                        supportsIdempotency: false,
                        applyAction: () => Effect.die("Unexpected action"),
                        queryFunction: () => Effect.void,
                        loadSubset: () =>
                            Effect.sync(() => {
                                loads++;
                                return { rows, complete: true, fulfilledSubset: objectSubset("Issue") };
                            }),
                    });
                    const replica = yield* makeReplica({
                        namespace: "broader",
                        ir,
                        tables: yield* Memory.make(),
                        backend,
                        execute: () => Effect.void,
                        startSync: false,
                        storeBroaderSubsets,
                        demand: { idleRetentionMs: 0 },
                    });
                    yield* replica.demand(selected);
                    yield* replica.syncSubset(selected);
                    expect(yield* replica.loadSubset("Issue")).toHaveLength(storeBroaderSubsets ? 40 : 5);
                    expect(
                        (yield* replica.loadSubset("Issue", selected.query)).map((row) => row.key)
                    ).toEqual(["i0", "i1", "i2", "i3", "i4"]);
                    if (!storeBroaderSubsets) return;
                    const other = { objectType: "Issue", query: { where: eq(field("id"), "i39") } };
                    const scope = yield* Scope.make();
                    yield* replica.demand(other).pipe(Scope.provide(scope));
                    yield* replica.syncSubset(other);
                    expect(loads).toBe(1);
                    yield* Scope.close(scope, Exit.void);
                    expect(yield* replica.collectGarbage({ minUnusedAgeMs: 0, maxCandidates: 100 })).toBe(35);
                    expect(yield* replica.loadSubset("Issue")).toHaveLength(5);
                    yield* replica.demand(other);
                    yield* replica.syncSubset(other);
                    expect(loads).toBe(2);
                    expect((yield* replica.get("Issue", "i39"))?.rank).toBe(39);
                })
            )
        );
    });

test("narrow watcher hints invalidate broader coverage before it can suppress refresh", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const hints = yield* PubSub.unbounded<void>();
                let loads = 0;
                let current = rows;
                const backend: OntologyBackendService = makeOntologyBackend({
                    ir,
                    name: "test",
                    sourceId: "test",
                    supportsIdempotency: false,
                    applyAction: () => Effect.die("Unexpected action"),
                    queryFunction: () => Effect.void,
                    watchSubset: () => PubSub.subscribe(hints).pipe(Effect.map(Stream.fromSubscription)),
                    loadSubset: () =>
                        Effect.sync(() => {
                            loads++;
                            return { rows: current, complete: true, fulfilledSubset: objectSubset("Issue") };
                        }),
                });
                const replica = yield* makeReplica({
                    namespace: "watched-broader",
                    ir,
                    tables: yield* Memory.make(),
                    backend,
                    execute: () => Effect.void,
                    startSync: false,
                    storeBroaderSubsets: true,
                });
                yield* replica.demand(selected);
                yield* Effect.yieldNow;
                yield* replica.syncSubset(selected);
                expect(loads).toBe(1);
                current = rows.map((row) =>
                    row.key === "i0" ? { ...row, value: { ...row.value, rank: 99 } } : row
                );
                yield* PubSub.publish(hints, undefined);
                yield* Effect.sleep(1);
                yield* replica.syncSubset(selected);
                expect(loads).toBe(2);
                expect((yield* replica.loadSubset("Issue", selected.query)).map((row) => row.key)).toEqual([
                    "i1",
                    "i2",
                    "i3",
                    "i4",
                    "i5",
                ]);
            })
        )
    );
});

test("a narrow watch failure does not leave a reusable broader coverage claim", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const stop = yield* PubSub.unbounded<void>();
                let loads = 0;
                const replica = yield* makeReplica({
                    namespace: "failed-watch-broader",
                    ir,
                    tables: yield* Memory.make(),
                    execute: () => Effect.void,
                    startSync: false,
                    storeBroaderSubsets: true,
                    backend: makeOntologyBackend({
                        ir,
                        name: "test",
                        sourceId: "test",
                        supportsIdempotency: false,
                        applyAction: () => Effect.die("Unexpected action"),
                        queryFunction: () => Effect.void,
                        watchSubset: () =>
                            PubSub.subscribe(stop).pipe(
                                Effect.map((subscription) =>
                                    Stream.fromSubscription(subscription).pipe(
                                        Stream.flatMap(() =>
                                            Stream.fail(
                                                new BackendError({
                                                    operation: "watch",
                                                    kind: "Unavailable",
                                                    retryable: true,
                                                    message: "Lost watch",
                                                })
                                            )
                                        )
                                    )
                                )
                            ),
                        loadSubset: () =>
                            Effect.sync(() => {
                                loads++;
                                return { rows, complete: true, fulfilledSubset: objectSubset("Issue") };
                            }),
                    }),
                });
                yield* replica.demand(selected);
                yield* Effect.yieldNow;
                yield* replica.syncSubset(selected);
                yield* PubSub.publish(stop, undefined);
                yield* Effect.sleep(1);
                yield* replica.syncSubset(selected);
                expect(loads).toBe(2);
            })
        )
    );
});

test("default storage retains the required offset prefix without retaining the broader collection", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const replica = yield* makeReplica({
                    namespace: "broader-offset",
                    ir,
                    tables: yield* Memory.make(),
                    execute: () => Effect.void,
                    startSync: false,
                    backend: makeOntologyBackend({
                        ir,
                        name: "test",
                        sourceId: "test",
                        supportsIdempotency: false,
                        applyAction: () => Effect.die("Unexpected action"),
                        queryFunction: () => Effect.void,
                        loadSubset: () =>
                            Effect.succeed({ rows, complete: true, fulfilledSubset: objectSubset("Issue") }),
                    }),
                });
                const subset = { ...selected, query: { ...selected.query, offset: 10 } };
                yield* replica.demand(subset);
                yield* replica.syncSubset(subset);
                expect(yield* replica.loadSubset("Issue")).toHaveLength(15);
                expect((yield* replica.loadSubset("Issue", subset.query)).map((row) => row.key)).toEqual([
                    "i10",
                    "i11",
                    "i12",
                    "i13",
                    "i14",
                ]);
            })
        )
    );
});
