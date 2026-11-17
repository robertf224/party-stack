import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { type StoredIndex } from "@party-stack/ontology-storage/driver";
import {
    Table,
    applyQuery,
    eq,
    field,
    gt,
    gte,
    length,
    lengthComparison,
    lengthEmptiness,
    lt,
    lte,
    ne,
    not,
    type Query,
} from "@party-stack/ontology-storage/tables";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { compileQuery, type Dialect } from "./compiler.js";
import { make } from "./tables.js";

type Row = { tags?: string[]; title?: string };
const values: Record<string, Row> = {
    missing: {},
    empty: { tags: [], title: "" },
    one: { tags: ["a"], title: "a" },
    // The multi-entry projection holds distinct elements, so duplicates must not count once.
    duplicate: { tags: ["a", "a"], title: "ab" },
    three: { tags: ["a", "b", "c"], title: "abc" },
};

const check = (dialect: Dialect) =>
    Effect.gen(function* () {
        const tables = yield* make();
        // Rows written before the index exists are backfilled without an entry for an
        // empty or missing list; rows written after it get an explicit empty projection.
        const before = Table.make<Row>({ name: "length_backfilled" });
        const after = Table.make<Row>({ name: "length_written" });
        const indexes = (table: string): StoredIndex[] => [
            { name: "tags", field: field("tags"), multiEntry: true, table, version: 1 },
        ];
        for (const [key, value] of Object.entries(values)) yield* tables.put(before, key, value);
        for (const table of [before, after])
            for (const index of indexes(table.name)) yield* tables.ensureIndex(table, index);
        for (const [key, value] of Object.entries(values)) yield* tables.put(after, key, value);
        const rows = Object.entries(values).map(([key, value]) => ({ key, value }));
        for (const table of [before, after])
            for (const property of ["tags", "title"])
                for (const build of [eq, ne, lt, lte, gt, gte])
                    for (const bound of [-1, 0, 0.5, 1, 2])
                        for (const where of [
                            build(length(field(property)), bound),
                            build(bound, length(field(property))),
                            not(build(length(field(property)), bound)),
                        ]) {
                            const query: Query = { where };
                            const keys = (selected: readonly { key: unknown }[]) =>
                                selected.map((row) => String(row.key)).sort();
                            expect(keys(yield* tables.query(table, query))).toEqual(
                                keys(applyQuery(rows, query))
                            );
                            // Only list emptiness is native; other lengths are evaluated on rows.
                            const counted = lengthComparison(
                                where.kind === "not" ? where.value.expression : where
                            )!;
                            const compiled = compileQuery(dialect, indexes(table.name), query);
                            expect(compiled.complete).toBe(
                                property === "tags" &&
                                    lengthEmptiness(counted.op, counted.bound) !== undefined
                            );
                            if (compiled.complete)
                                expect(compiled.condition).toContain(
                                    dialect === "pg" ? "jsonb_array_length" : "json_array_length"
                                );
                        }
        expect(
            compileQuery(dialect, indexes(after.name), { where: eq(length(field("tags")), 0) }).complete
        ).toBe(true);
        expect(
            compileQuery(dialect, indexes(after.name), { where: gt(length(field("tags")), 0) }).complete
        ).toBe(true);
        expect(
            compileQuery(dialect, indexes(after.name), { where: eq(length(field("tags")), 2) }).complete
        ).toBe(false);
        expect(compileQuery(dialect, [], { where: eq(length(field("tags")), 0) }).complete).toBe(false);
    });

test("SQLite counts list emptiness from the multi-entry projection and evaluates other lengths on rows", async () => {
    await Effect.runPromise(
        check("sqlite").pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })))
    );
}, 30000);
test("PostgreSQL counts list emptiness from the multi-entry projection and evaluates other lengths on rows", async () => {
    await Effect.runPromise(check("pg").pipe(Effect.provide(PgliteClient.layer())));
}, 30000);
