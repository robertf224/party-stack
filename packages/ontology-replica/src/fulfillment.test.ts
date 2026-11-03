import { BackendError } from "@party-stack/ontology-backend";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { o } from "@party-stack/ontology-spec";
import { eq, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect, PubSub, Scope, Exit, Stream } from "effect";
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

for (const storeBroaderSubsets of [undefined, false, true])
    test(`broader snapshots retain extra objects only with explicit opt-in (${storeBroaderSubsets})`, async () => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    let loads = 0;
                    const backend: OntologyBackendService = {
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
                    };
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
                const backend: OntologyBackendService = {
                    name: "test",
                    sourceId: "test",
                    supportsIdempotency: false,
                    applyAction: () => Effect.die("Unexpected action"),
                    queryFunction: () => Effect.void,
                    watchSubset: () => Stream.fromPubSub(hints),
                    loadSubset: () =>
                        Effect.sync(() => {
                            loads++;
                            return { rows: current, complete: true, fulfilledSubset: objectSubset("Issue") };
                        }),
                };
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
                    backend: {
                        name: "test",
                        sourceId: "test",
                        supportsIdempotency: false,
                        applyAction: () => Effect.die("Unexpected action"),
                        queryFunction: () => Effect.void,
                        watchSubset: () =>
                            Stream.fromPubSub(stop).pipe(
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
                            ),
                        loadSubset: () =>
                            Effect.sync(() => {
                                loads++;
                                return { rows, complete: true, fulfilledSubset: objectSubset("Issue") };
                            }),
                    },
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
                    backend: {
                        name: "test",
                        sourceId: "test",
                        supportsIdempotency: false,
                        applyAction: () => Effect.die("Unexpected action"),
                        queryFunction: () => Effect.void,
                        loadSubset: () =>
                            Effect.succeed({ rows, complete: true, fulfilledSubset: objectSubset("Issue") }),
                    },
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
