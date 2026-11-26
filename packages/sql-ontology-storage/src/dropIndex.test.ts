import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { Table, field } from "@party-stack/ontology-storage/tables";
import { Effect, type Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { expect, test } from "vitest";
import { make } from "./tables.js";

interface Facility {
    readonly code: string;
    readonly region: string;
    readonly wings: readonly string[];
}
const facilities: readonly { readonly key: string; readonly value: Facility }[] = [
    { key: "north", value: { code: "N1", region: "east", wings: ["a", "b"] } },
    { key: "south", value: { code: "S1", region: "east", wings: [] } },
];
const dialects: readonly [string, () => Layer.Layer<SqlClient.SqlClient, unknown>][] = [
    ["SQLite", () => SqliteClient.layer({ filename: ":memory:" })],
    ["PostgreSQL", () => PgliteClient.layer()],
];

for (const [dialect, layer] of dialects)
    test(`${dialect} drops a dropped index's native indexes and projections, and only that table's`, async () => {
        await Effect.runPromise(
            Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const tables = yield* make();
                const sqlite = dialect === "SQLite";
                const native = () =>
                    (sqlite
                        ? sql<{
                              name: string;
                          }>`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='party_tables_rows' AND name LIKE 'party_tables_i_%'`
                        : sql<{
                              name: string;
                          }>`SELECT indexname AS name FROM pg_indexes WHERE tablename='party_tables_rows' AND indexname LIKE 'party_tables_i_%'`
                    ).pipe(Effect.map((rows) => rows.map((row) => row.name).sort()));
                const projections = (table: string) =>
                    (sqlite
                        ? sql<{
                              projection: string;
                          }>`SELECT projection FROM party_tables_rows WHERE table_name=${table} ORDER BY row_key`
                        : sql<{
                              projection: string;
                          }>`SELECT projection::text AS projection FROM party_tables_rows WHERE table_name=${table} ORDER BY row_key`
                    ).pipe(Effect.map((rows) => rows.map((row) => row.projection)));
                // A hostile table name exercises the partial-index predicate match.
                const kept = Table.make<Facility>({ name: "Facility" });
                const reset = Table.make<Facility>({ name: `Facility' OR "x"='x\\` });
                const define = (table: Table<Facility>) =>
                    Effect.gen(function* () {
                        yield* tables.putMany(table, facilities);
                        yield* tables.ensureIndex(table, {
                            name: "code",
                            field: field("code"),
                            unique: true,
                        });
                        yield* tables.ensureIndex(table, {
                            name: "wings",
                            field: field("wings"),
                            multiEntry: true,
                        });
                        yield* tables.ensureIndex(table, {
                            name: "wingCount",
                            field: field("wings"),
                            size: true,
                        });
                    });
                yield* define(kept);
                const keptIndexes = yield* native();
                yield* define(reset);
                expect((yield* native()).length).toBeGreaterThan(keptIndexes.length);

                yield* tables.transaction((tx) =>
                    Effect.gen(function* () {
                        for (const index of yield* tx.indexes(reset)) yield* tx.dropIndex(reset, index.name);
                    })
                );
                expect(yield* native()).toEqual(keptIndexes);
                expect((yield* projections(reset.name)).map((value) => JSON.parse(value))).toEqual([{}, {}]);
                expect(yield* tables.indexes(reset)).toEqual([]);
                expect((yield* tables.indexes(kept)).map((index) => index.name).sort()).toEqual([
                    "code",
                    "wingCount",
                    "wings",
                ]);
                expect(yield* tables.insert(kept, "west", { code: "N1", region: "west", wings: [] })).toBe(
                    false
                );

                // The same name now indexes a repeated value, which a stale unique index would reject.
                yield* tables.ensureIndex(reset, { name: "code", field: field("region") });
                expect(yield* tables.insert(reset, "west", { code: "N1", region: "east", wings: [] })).toBe(
                    true
                );
            }).pipe(Effect.provide(layer()))
        );
    }, 30_000);
