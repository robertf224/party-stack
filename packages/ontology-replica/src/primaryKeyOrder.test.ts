import { it } from "@effect/vitest";
import { field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { deleteVisible, loadVisible, overlay, putVisible } from "@party-stack/ontology-storage/overlay";
import { applyQuery, cursorOf, Table } from "@party-stack/ontology-storage/tables";
import { Arbitrary, Effect, Schema } from "effect";
import { expect, test } from "vitest";
import { putIncomingBaseRows } from "./incoming.js";
import { primaryKeyOrder, primaryKeyQueries } from "./primaryKeyOrder.js";
import type { Key, Query, Row } from "@party-stack/ontology-storage";
import type { ReadTable } from "@party-stack/ontology-storage/tables";

const ordered = (direction: "asc" | "desc" = "asc"): Query => ({
    orderBy: [
        { field: field("rank"), direction },
        { field: field("id"), nulls: "first" },
    ],
    offset: 2,
    limit: 7,
});

test("only a final ascending declared primary key and a matching full cursor are redundant", () => {
    const query = ordered("desc");
    expect(primaryKeyOrder(query, "id").orderBy).toEqual(query.orderBy!.slice(0, -1));
    const after = { values: [3, "a"], key: "a" };
    expect(primaryKeyOrder({ ...query, after }, "id").after).toEqual({ values: [3], key: "a" });
    for (const key of [-12, -0, 0.5, 23, "", "a", "💛"]) {
        const keyed = { ...query, after: { values: [3, key], key } };
        expect(primaryKeyOrder(keyed, "id").after).toEqual({ values: [3], key });
    }
    for (const unchanged of [
        { ...query, orderBy: [{ field: field("id"), direction: "desc" as const }] },
        { ...query, orderBy: [{ field: field("other") }] },
        { ...query, after: { values: [3, "different"], key: "a" } },
        { ...query, after: { values: ["a"], key: "a" } },
        { ...query, after: { values: [3, "a", "extra"], key: "a" } },
        { ...query, after: { values: [3, NaN], key: NaN } },
    ])
        expect(primaryKeyOrder(unchanged, "id")).toBe(unchanged);
    expect(primaryKeyOrder(query, "anotherKey")).toBe(query);
});

test("translation is tied to the exact replica table, not an index name or alternate decoder", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const base = Table.make<{ id: string; rank: number }>({ name: "declared-pk" });
            const alternative = Table.make<{ id: string; rank: number }>({
                name: base.name,
                codec: {
                    encode: (value) => value,
                    decode: (input) => {
                        const row = input as { id: string; rank: number };
                        return { ...row, id: row.id === "a" ? "z" : "a" };
                    },
                },
            });
            yield* tables.putMany(base, [
                { key: "a", value: { id: "a", rank: 1 } },
                { key: "b", value: { id: "b", rank: 1 } },
            ]);
            const metadata = new Map<ReadTable<unknown>, string>([[base, "id"]]);
            yield* tables.read((tx) =>
                Effect.gen(function* () {
                    const wrapped = primaryKeyQueries(tx, metadata);
                    const query: Query = { orderBy: [{ field: field("id") }], limit: 2 };
                    expect(yield* wrapped.query(base, query)).toEqual(yield* tx.query(base, query));
                    expect(yield* wrapped.query(alternative, query)).toEqual(
                        yield* tx.query(alternative, query)
                    );
                    expect((yield* wrapped.query(alternative, query)).map((row) => row.key)).toEqual([
                        "b",
                        "a",
                    ]);
                })
            );
        })
    );
});

test("replica installation rejects mismatched string and numeric stored keys before making them queryable", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const base = Table.make<Record<string, unknown>>({ name: "validated-pk" });
            const view = overlay(base, { name: "validated-pk-own" });
            for (const key of ["a", "", -12, 0, 1.5]) {
                const error = yield* tables
                    .transaction((tx) =>
                        putIncomingBaseRows(
                            tx,
                            view,
                            "id",
                            [],
                            [{ key, value: { id: typeof key === "string" ? 1 : "different", rank: 1 } }]
                        )
                    )
                    .pipe(Effect.flip);
                expect(error).toMatchObject({ kind: "InvalidResponse" });
                expect(yield* tables.query(base)).toEqual([]);
            }
        })
    );
});

test("base key normalization preserves overlay predictions, deletes and full original cursor semantics", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const base = Table.make<Record<string, unknown>>({ name: "overlay-pk" });
            const view = overlay(base, { name: "overlay-pk-own" });
            const rows: Row<Record<string, unknown>>[] = Array.from({ length: 400 }, (_, n) => ({
                key: n % 3 ? `id-${String(n).padStart(4, "0")}` : n - 200,
                value: { id: n % 3 ? `id-${String(n).padStart(4, "0")}` : n - 200, rank: n >> 2 },
            }));
            const metadata = new Map<ReadTable<unknown>, string>([[base, "id"]]);
            yield* tables.transaction((tx) =>
                Effect.gen(function* () {
                    yield* tx.ensureIndex(base, { name: "rank", field: field("rank") });
                    yield* putIncomingBaseRows(tx, view, "id", [], rows);
                })
            );
            const held = yield* tables.query(base);
            yield* tables.transaction((tx) =>
                Effect.gen(function* () {
                    yield* deleteVisible(tx, view, rows[396]!.key);
                    yield* putVisible(tx, view, rows[395]!.key, { ...rows[395]!.value, rank: 999 });
                    yield* putVisible(tx, view, "new", { id: "new", rank: 99 });
                    const visible = rows
                        .filter((row) => row.key !== rows[396]!.key && row.key !== rows[395]!.key)
                        .concat([
                            { key: rows[395]!.key, value: { ...rows[395]!.value, rank: 999 } },
                            { key: "new", value: { id: "new", rank: 99 } },
                        ]);
                    for (const direction of ["asc", "desc"] as const) {
                        const query = ordered(direction);
                        for (const scan of [
                            query,
                            { ...query, after: cursorOf(visible[350]!, query) },
                            { ...query, after: { values: [99, "mismatch"], key: "other" } },
                        ]) {
                            expect(yield* loadVisible(primaryKeyQueries(tx, metadata), view, scan)).toEqual(
                                applyQuery(visible, scan)
                            );
                        }
                    }
                })
            );
            expect(held).toEqual(applyQuery(rows));
            expect(yield* tables.query(base)).toEqual(held);
        })
    );
});

it.effect.prop(
    "declared PK elision preserves arbitrary valid string and number key cursors",
    [
        Arbitrary.schema(
            Schema.Struct({
                descending: Schema.Boolean,
                keys: Schema.Array(Schema.Union([Schema.String, Schema.Number.check(Schema.isFinite())])),
                offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
            })
        ),
    ],
    ([input]) =>
        Effect.sync(() => {
            const keys: Key[] = [...new Set<Key>(input.keys)];
            const rows = keys.map((key, n) => ({ key, value: { id: key, rank: n % 3 } }));
            const query = { ...ordered(input.descending ? "desc" : "asc"), offset: input.offset };
            for (const scan of [
                query,
                ...rows.slice(0, 8).map((row) => ({ ...query, after: cursorOf(row, query) })),
            ])
                expect(applyQuery(rows, primaryKeyOrder(scan, "id"))).toEqual(applyQuery(rows, scan));
        }),
    { arbitrary: { runs: 160, size: 8, seed: "declared-pk-order-v1" } }
);
