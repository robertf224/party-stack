import { Arbitrary, Effect, Schema } from "effect";
import { expect, test } from "vitest";
import { Table, and, applyQuery, cursorOf, eq, field, gte, type Key, type Query } from "../table-api.js";
import { runContract, runBlobContract } from "../testing/index.js";
import { runOntologyContract } from "../testing/ontology.js";
import * as Memory from "./tables.js";

test("Memory Tables passes the same transactional/query/overlay contract", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            yield* runContract(tables);
            yield* runOntologyContract(tables);
            yield* runBlobContract(tables);
        })
    );
});
test("Independent memory services do not share state", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const first = yield* Memory.make(),
                second = yield* Memory.make();
            const rows = Table.make<number>({ name: "rows" });
            yield* first.put(rows, "key", 1);
            expect(yield* first.get(rows, "key")).toBe(1);
            expect(yield* second.get(rows, "key")).toBeUndefined();
        })
    );
});

test("key-ordered scans hydrate only their selected values, once", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            let decodes = 0;
            const rows = Table.make<{ label: string }>({
                name: "key-window",
                codec: {
                    encode: (value) => value,
                    decode: (value) => {
                        decodes++;
                        return value as { label: string };
                    },
                },
            });
            for (const key of ["z", 10, -2, "a", 1]) yield* tables.put(rows, key, { label: String(key) });
            decodes = 0;
            expect(yield* tables.query(rows, { offset: 1, limit: 2 })).toEqual([
                { key: 1, value: { label: "1" } },
                { key: 10, value: { label: "10" } },
            ]);
            expect(decodes).toBe(2);
            decodes = 0;
            expect(yield* tables.query(rows, { after: { key: 1, values: [] }, limit: 2 })).toEqual([
                { key: 10, value: { label: "10" } },
                { key: "a", value: { label: "a" } },
            ]);
            expect(decodes).toBe(2);
        })
    );
});

test("native primary-key pages do not decode discarded row values", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            let decodes = 0;
            const rows = Table.make<number>({
                name: "keys-without-values",
                codec: {
                    encode: (value) => value,
                    decode: (value) => {
                        decodes++;
                        return value as number;
                    },
                },
            });
            yield* tables.putMany(
                rows,
                Array.from({ length: 260 }, (_, key) => ({ key, value: key }))
            );
            decodes = 0;
            expect(yield* tables.keys(rows, { after: 127, limit: 128 })).toEqual(
                Array.from({ length: 128 }, (_, n) => n + 128)
            );
            expect(decodes).toBe(0);
            expect(yield* tables.get(rows, 128)).toBe(128);
            expect(decodes).toBe(1);
        })
    );
});

test("indexed key windows agree with full scans across mixed keys and residual filters", async () => {
    const result = await Effect.runPromise(
        Arbitrary.checkEffect(
            Arbitrary.schema(Schema.Int),
            (seed) =>
                Effect.gen(function* () {
                    const tables = yield* Memory.make();
                    const table = Table.make<{ group: number; score: number }>({ name: "key-pages" });
                    const all = Array.from({ length: 200 }, (_, i) => ({
                        key: (i < 100 ? i - 50 : `row-${i}`) as Key,
                        value: { group: i % 3, score: (i * (Math.abs(seed % 13) + 1)) % 17 },
                    }));
                    yield* tables.transaction((tx) =>
                        Effect.gen(function* () {
                            for (const row of all) yield* tx.put(table, row.key, row.value);
                            yield* tx.ensureIndex(table, { name: "group", field: field("group") });
                            for (let i = 0; i < all.length; i += 13) {
                                const row = all[i]!;
                                // Cover both stable index values and moves to a
                                // new bucket before comparing with the scan oracle.
                                row.value = {
                                    group: i % 2 === 0 ? row.value.group : (row.value.group + 1) % 3,
                                    score: Math.abs(seed % 17),
                                };
                                yield* tx.put(table, row.key, row.value);
                            }
                        })
                    );
                    for (const key of [-51, -3, 10, "row-130", "zz"] as const) {
                        const query: Query = {
                            where: and(eq(field("group"), Math.abs(seed % 3)), gte(field("score"), 4)),
                            after: { key, values: [] },
                            offset: Math.abs(seed % 5),
                            limit: Math.abs(seed % 19) + 1,
                        };
                        const actual = yield* tables.query(table, query);
                        yield* Effect.try(() => expect(actual).toEqual(applyQuery(all, query)));
                    }
                    return true;
                }),
            { runs: 40 }
        )
    );
    expect(Arbitrary.formatCheckFailure(result)).toBeUndefined();
});

test("composite index windows match a full-sort oracle across cursors, ties and residual filters", async () => {
    const result = await Effect.runPromise(
        Arbitrary.checkEffect(
            Arbitrary.schema(Schema.Struct({ seed: Schema.Int, descending: Schema.Boolean })),
            ({ seed, descending }) =>
                Effect.gen(function* () {
                    const tables = yield* Memory.make();
                    type Value = { pinned: boolean; rank?: number | null; label: string; keep: boolean };
                    const table = Table.make<Value>({ name: "composite-pages" });
                    const salt = Math.abs(seed % 31);
                    const all = Array.from({ length: 200 }, (_, i) => ({
                        key: (i < 100 ? i - 50 : `row-${i}`) as Key,
                        value: {
                            pinned: i % 7 === 0,
                            rank: i % 13 === 0 ? undefined : i % 11 === 0 ? null : (i + salt) % 17,
                            label: String((i + salt) % 9),
                            keep: i % 3 === 0,
                        } satisfies Value,
                    }));
                    yield* tables.transaction((tx) =>
                        Effect.gen(function* () {
                            for (const name of ["pinned", "rank", "label"])
                                yield* tx.ensureIndex(table, { name, field: field(name) });
                            yield* tx.putMany(table, all);
                            all[0]!.value.label = "changed";
                            all[1]!.value.pinned = !all[1]!.value.pinned;
                            yield* tx.putMany(table, all.slice(0, 2));
                        })
                    );
                    for (const where of [
                        undefined,
                        eq(field("keep"), true),
                        and(gte(field("rank"), 0), eq(field("keep"), true)),
                    ]) {
                        const orderBy: Query["orderBy"] = [
                            { field: field("pinned"), direction: descending ? "desc" : "asc" },
                            { field: field("rank"), direction: descending ? "asc" : "desc" },
                            { field: field("label"), direction: "desc" },
                        ];
                        const ordered = applyQuery(all, { where, orderBy });
                        const cursor = ordered[salt % Math.max(1, ordered.length)];
                        for (const after of [undefined, cursor && cursorOf(cursor, { orderBy })]) {
                            const query: Query = { where, orderBy, after, offset: salt % 7, limit: 1 + salt };
                            const actual = yield* tables.query(table, query);
                            yield* Effect.try(() => expect(actual).toEqual(applyQuery(all, query)));
                        }
                        for (const nulls of ["first", "last"] as const) {
                            for (const orders of [
                                [orderBy[0]!, { ...orderBy[1]!, nulls }],
                                [{ ...orderBy[1]!, nulls }],
                            ]) {
                                const sorted = applyQuery(all, { where, orderBy: orders });
                                const cursor = sorted[salt % Math.max(1, sorted.length)];
                                for (const after of [
                                    undefined,
                                    cursor && cursorOf(cursor, { orderBy: orders }),
                                ]) {
                                    const query: Query = { where, orderBy: orders, after, limit: 12 };
                                    const actual = yield* tables.query(table, query);
                                    yield* Effect.try(() => expect(actual).toEqual(applyQuery(all, query)));
                                }
                            }
                        }
                    }
                    return true;
                }),
            { runs: 30 }
        )
    );
    expect(Arbitrary.formatCheckFailure(result)).toBeUndefined();
});
