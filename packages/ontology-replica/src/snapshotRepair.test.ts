import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { evaluateQuery, field, gt } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Exit, Scope } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { makeReplica } from "./testing.js";
import type { Query, Row } from "@party-stack/ontology-storage";
import type { TablesService, Transaction } from "@party-stack/ontology-storage/tables";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "rank", displayName: "Rank", type: o.integer({}) },
            ],
        },
    ],
    actionTypes: [
        {
            name: "remove",
            displayName: "Remove",
            parameters: [{ name: "id", displayName: "Id", type: o.string({}) }],
            logic: [],
        },
    ],
};

test("bounded snapshot repair protects later optimistic windows from stale rows below the fresh boundary", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let source: Row<Record<string, unknown>>[] = [
                    { key: "a", value: { id: "a", rank: 3 } },
                    { key: "b", value: { id: "b", rank: 2 } },
                    { key: "c", value: { id: "c", rank: 1 } },
                ];
                const requests: Query[] = [];
                const replica = yield* makeReplica({
                    namespace: "bounded-snapshot-repair",
                    ir,
                    tables: yield* Memory.make(),
                    startSync: false,
                    demand: { refresh: { maxCoverageAgeMs: 0 } },
                    execute: (tx, invocation) => tx.delete("Item", String(invocation.parameters.id)),
                    backend: makeOntologyBackend({
                        ir,
                        name: "snapshot",
                        sourceId: "snapshot",
                        supportsIdempotency: false,
                        applyAction: () => Effect.die("Unexpected dispatch"),
                        queryFunction: () => Effect.void,
                        loadSubset: (request) =>
                            compileObjectSubset(ir, request).pipe(
                                Effect.map((subset) => {
                                    requests.push(subset.query ?? {});
                                    return { rows: evaluateQuery(source, subset.query), complete: true };
                                })
                            ),
                    }),
                });
                const initial = yield* Scope.make();
                yield* Scope.provide(replica.demand({ objectType: "Item" }), initial);
                yield* replica.syncSubset({ objectType: "Item" });
                yield* Scope.close(initial, Exit.void);

                // C's old rank is below a completely filled fresh prefix. Its
                // absence cannot affect that confirmed prefix, but a later
                // optimistic removal can expose its stale matching value.
                source = source.filter((row) => row.key !== "c");
                requests.length = 0;
                const query: Query = {
                    where: gt(field("rank"), 0),
                    orderBy: [{ field: field("rank"), direction: "desc" }],
                    limit: 2,
                };
                const subset = { objectType: "Item", query };
                yield* replica.demand(subset);
                yield* replica.syncSubset(subset);
                expect((yield* replica.confirmed.loadSubset("Item", query)).map((row) => row.key)).toEqual([
                    "a",
                    "b",
                ]);
                expect(requests.some((request) => request.where?.op === "in")).toBe(true);

                yield* replica.enqueue({ id: "remove-a", name: "remove", parameters: { id: "a" } });
                const expected = source.filter((row) => row.key !== "a");
                expect(yield* replica.loadSubset("Item", query)).toEqual(evaluateQuery(expected, query));
            })
        )
    );
});

test("identity repairs preserve unchanged cache ages without losing changed, inserted, or demanded rows", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const namespace = "snapshot-repair-ages";
                const storage = yield* Memory.make();
                const retention = Table.make<{ objectType: string; key: string; accessedAt: number }>({
                    name: JSON.stringify(["replica", namespace, "retention"]),
                });
                const base = Table.make<Record<string, unknown>>({
                    name: JSON.stringify(["replica", namespace, "base:Item"]),
                });
                const retentionWrites: string[] = [];
                const tables: TablesService = {
                    ...storage,
                    transaction: (body) =>
                        storage.transaction((tx) => {
                            const putMany: Transaction["putMany"] = (table, rows) => {
                                if (table.name === retention.name)
                                    retentionWrites.push(...rows.map((row) => String(row.key)));
                                return tx.putMany(table, rows);
                            };
                            return body({ ...tx, putMany });
                        }),
                };
                let source: Row<Record<string, unknown>>[] = Array.from({ length: 140 }, (_, index) => ({
                    key: `i${index}`,
                    value: { id: `i${index}`, rank: 140 - index },
                }));
                let evictDuringRepair = false;
                const replica = yield* makeReplica({
                    namespace,
                    ir,
                    tables,
                    startSync: false,
                    execute: () => Effect.void,
                    demand: { refresh: { maxCoverageAgeMs: 0 } },
                    backend: makeOntologyBackend({
                        ir,
                        name: "snapshot",
                        sourceId: "snapshot",
                        supportsIdempotency: false,
                        applyAction: () => Effect.die("Unexpected dispatch"),
                        queryFunction: () => Effect.void,
                        loadSubset: (request) =>
                            Effect.gen(function* () {
                                const subset = yield* compileObjectSubset(ir, request);
                                if (evictDuringRepair && subset.query?.where?.op === "in") {
                                    evictDuringRepair = false;
                                    // A concurrent collector can remove a candidate after
                                    // enumeration but before its identity repair is installed.
                                    yield* storage
                                        .transaction((tx) =>
                                            tx
                                                .delete(base, "i138")
                                                .pipe(
                                                    Effect.andThen(
                                                        tx.delete(retention, JSON.stringify(["Item", "i138"]))
                                                    )
                                                )
                                        )
                                        .pipe(Effect.orDie);
                                }
                                return { rows: evaluateQuery(source, subset.query), complete: true };
                            }),
                    }),
                });
                const initial = yield* Scope.make();
                yield* Scope.provide(replica.demand({ objectType: "Item" }), initial);
                yield* replica.syncSubset({ objectType: "Item" });
                yield* Scope.close(initial, Exit.void);
                retentionWrites.length = 0;
                yield* TestClock.adjust(100);
                source = source.map((row) =>
                    row.key === "i139" ? { ...row, value: { ...row.value, rank: -1 } } : row
                );
                evictDuringRepair = true;
                const query: Query = {
                    where: gt(field("rank"), 0),
                    orderBy: [{ field: field("rank"), direction: "desc" }],
                    limit: 2,
                };
                const selected = yield* Scope.make();
                yield* Scope.provide(replica.demand({ objectType: "Item", query }), selected);
                yield* replica.syncSubset({ objectType: "Item", query });

                expect(retentionWrites.sort()).toEqual(
                    ["i0", "i1", "i138", "i139"].map((id) => JSON.stringify(["Item", id])).sort()
                );
                const ages = new Map(
                    (yield* storage.query(retention)).map((row) => [row.value.key, row.value.accessedAt])
                );
                expect(ages.get("i0")).toBe(100);
                expect(ages.get("i2")).toBe(0);
                expect(ages.get("i138")).toBe(100);
                expect(ages.get("i139")).toBe(100);
                expect((yield* replica.get("Item", "i139"))?.rank).toBe(-1);

                expect(yield* replica.collectGarbage({ minUnusedAgeMs: 50, maxCandidates: 1000 })).toBe(136);
                yield* TestClock.adjust(100);
                // The actual selected prefix remains retained even after its
                // access age becomes eligible, while unrelated repairs expire.
                expect(yield* replica.collectGarbage({ minUnusedAgeMs: 50, maxCandidates: 1000 })).toBe(2);
                expect((yield* replica.loadSubset("Item", query)).map((row) => row.key)).toEqual([
                    "i0",
                    "i1",
                ]);
                yield* Scope.close(selected, Exit.void);
                expect(yield* replica.collectGarbage({ minUnusedAgeMs: 0, maxCandidates: 1000 })).toBe(2);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});
