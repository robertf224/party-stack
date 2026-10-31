import * as PgliteClient from "@effect/sql-pglite/PgLiteClient";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { type StoredIndex } from "@party-stack/ontology-storage/driver";
import {
    Table,
    and,
    applyQuery,
    contains,
    or,
    field,
    gte,
    ilike,
    like,
    type Query,
} from "@party-stack/ontology-storage/tables";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { expect, test } from "vitest";
import { compileQuery, literal, type Dialect } from "./compiler.js";
import { make } from "./tables.js";

const check = (dialect: Dialect) =>
    Effect.gen(function* () {
        const tables = yield* make();
        const sql = (yield* SqlClient.SqlClient).withoutTransforms();
        const table = Table.make<{ n: number; name: string; pattern: string }>({
            name: "query_plans'quoted",
        });
        const all = Array.from({ length: 1000 }, (_, n) => ({
            key: n,
            value: { n, name: `PrÉfix-${n}`, pattern: "PrÉfix-9_9" },
        }));
        const indexes: StoredIndex[] = ["n", "name"].map((name) => ({
            name,
            field: field(name),
            table: table.name,
            version: 1,
        }));
        yield* tables.withTransaction(
            Effect.gen(function* () {
                for (const row of all) yield* tables.put(table, row.key, row.value);
                for (const index of indexes) yield* tables.ensureIndex(table, index);
            })
        );
        const query: Query = { where: gte(field("n"), 990), orderBy: [{ field: field("n") }], limit: 5 };
        const compiled = compileQuery(dialect, indexes, query);
        expect(compiled.complete).toBe(true);
        expect(compiled.pagination).toContain("LIMIT");
        const statement = `SELECT row_key,data FROM party_tables_rows WHERE table_name=${literal(dialect, table.name)} AND (${compiled.condition}) ORDER BY ${compiled.order}${compiled.pagination}`;
        yield* sql.unsafe("ANALYZE party_tables_rows");
        const plan = yield* sql.unsafe(
            `${dialect === "sqlite" ? "EXPLAIN QUERY PLAN" : "EXPLAIN (FORMAT JSON)"} ${statement}`,
            compiled.params
        );
        expect(JSON.stringify(plan)).toMatch(
            dialect === "sqlite" ? /USING INDEX party_tables_i_/ : /Index (Only )?Scan/
        );
        expect(yield* tables.query(table, query)).toEqual(applyQuery(all, query));
        const ci: Query = { where: ilike(field("name"), "PRÉFIX-99%"), limit: 5 };
        expect(compileQuery(dialect, indexes, ci).complete).toBe(true);
        expect(yield* tables.query(table, ci)).toEqual(applyQuery(all, ci));
        // Dynamic row-valued patterns remain residual. Early SQL LIMIT could
        // return a short page before the exact predicate is evaluated.
        const residual: Query = {
            where: and(gte(field("n"), 900), like(field("name"), field("pattern"))),
            limit: 5,
            offset: 2,
        };
        const partial = compileQuery(dialect, indexes, residual);
        expect(partial.complete).toBe(false);
        expect(partial.condition).toContain(">=");
        expect(partial.pagination).toBe("");
        expect(yield* tables.query(table, residual)).toEqual(applyQuery(all, residual));
        const arrays = Table.make<{ title: string; tags: string[] }>({ name: "native_membership" });
        yield* tables.put(arrays, "label", { title: "unrelated", tags: ["urgent"] });
        yield* tables.put(arrays, "title", { title: "Urgent title", tags: [] });
        if (dialect === "pg")
            for (let n = 0; n < 1000; n++)
                yield* tables.put(arrays, `background-${n}`, { title: "other", tags: ["ordinary"] });
        const membershipIndexes: StoredIndex[] = [
            { name: "tags", field: field("tags"), multiEntry: true, table: arrays.name, version: 1 },
            { name: "title", field: field("title"), table: arrays.name, version: 1 },
        ];
        for (const index of membershipIndexes) yield* tables.ensureIndex(arrays, index);
        if (dialect === "pg") {
            yield* sql.unsafe("ANALYZE party_tables_rows");
            const membership = compileQuery(dialect, membershipIndexes, {
                where: contains(field("tags"), "urgent"),
            });
            const plan = yield* sql.unsafe(
                `EXPLAIN (FORMAT JSON) SELECT row_key FROM party_tables_rows WHERE table_name=${literal(dialect, arrays.name)} AND ${membership.condition}`,
                membership.params
            );
            expect(JSON.stringify(plan)).toContain("Bitmap Index Scan");
            expect(JSON.stringify(plan)).toMatch(/Index Cond.*\?/);
        }
        const membership: Query = {
            where: or(ilike(field("title"), "urgent%"), contains(field("tags"), "urgent")),
            limit: 1,
            offset: 1,
        };
        const pushed = compileQuery(dialect, membershipIndexes, membership);
        expect(pushed.complete).toBe(true);
        expect(pushed.pagination).toContain("LIMIT");
        expect(pushed.condition).toContain(dialect === "pg" ? "COALESCE" : "json_each");
        expect(pushed.condition).not.toContain("urgent");
        expect((yield* tables.query(arrays, membership)).map((row) => row.key)).toEqual(["title"]);
    });

test("SQLite uses native expression indexes and paginates residual queries correctly", async () => {
    await Effect.runPromise(
        check("sqlite").pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })))
    );
}, 30000);
test("PostgreSQL uses native expression indexes and paginates residual queries correctly", async () => {
    await Effect.runPromise(check("pg").pipe(Effect.provide(PgliteClient.layer())));
}, 30000);
