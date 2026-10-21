import * as PgliteClient from "@effect/sql-pglite/PgLiteClient";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { Table, and, eq, field, gt, inArray, like, type Query } from "@party-stack/ontology-storage/tables";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { assert, test } from "vitest";
import { compileQuery, type Dialect } from "./compiler.js";
import { make } from "./tables.js";

const check = Effect.fnUntraced(function* (dialect: Dialect) {
    const sql = (yield* SqlClient.SqlClient).withoutTransforms();
    // Exercise the server setting under which ordinary quote doubling is insufficient.
    if (dialect === "pg") yield* sql.unsafe("SET standard_conforming_strings=off");
    const tables = yield* make();
    const hostile = "x\\'; DROP TABLE party_tables_rows; -- \" %_ 😀";
    const table = Table.make<Record<string, string | number>>({ name: hostile });
    const index = { name: hostile, field: field(hostile) };
    yield* tables.put(table, hostile, { [hostile]: hostile, n: 1, other: 2 });
    yield* tables.put(table, "safe", { [hostile]: "safe", n: 3, other: 2 });
    yield* tables.ensureIndex(table, index);
    yield* tables.ensureIndex(table, { name: "n", field: field("n") });
    yield* tables.ensureIndex(table, { name: "other", field: field("other") });
    for (const predicate of [
        eq(field(hostile), hostile),
        eq(hostile, field(hostile)),
        inArray(field(hostile), [hostile]),
        like(field(hostile), hostile),
    ]) {
        assert.deepEqual(
            (yield* tables.loadSubset(table, { where: predicate })).map((r) => r.key),
            [hostile]
        );
    }
    const both = and(gt(field("other"), field("n")), eq(2, 2));
    const declared = ["n", "other"].map((name) => ({
        name,
        field: field(name),
        table: table.name,
        version: 1,
    }));
    assert.strictEqual(compileQuery(dialect, declared, { where: both }).complete, true);
    assert.deepEqual(
        (yield* tables.loadSubset(table, { where: both })).map((r) => r.key),
        [hostile]
    );
    const compiled = compileQuery(dialect, [{ ...index, table: table.name, version: 1 }], {
        where: eq(field(hostile), hostile),
        limit: 1,
    });
    assert.strictEqual(compiled.complete, true);
    assert.notInclude(compiled.condition, hostile);
    assert.strictEqual(compiled.params.length, 2);
    assert.deepEqual(yield* tables.get(table, hostile), { [hostile]: hostile, n: 1, other: 2 });
    assert.strictEqual(
        Number(
            (yield* sql<{ count: string | number }>`SELECT COUNT(*) AS count FROM party_tables_rows`)[0]!
                .count
        ),
        2
    );
    for (const malformed of [
        { where: { op: "eq) OR 1=1 --", left: field("n"), right: 1 } },
        { orderBy: [{ field: field("n"), direction: "asc; DROP TABLE party_tables_rows; --" }] },
        { where: { op: "prefix", field: field("n"), value: "x" } },
        { where: { op: "eq", left: { _tag: "Field", path: [7] }, right: 1 } },
        { limit: "1; DROP TABLE party_tables_rows" },
    ]) {
        assert.strictEqual(
            yield* tables.loadSubset(table, malformed as unknown as Query).pipe(
                Effect.as(false),
                Effect.catchReason("OntologyStorageError", "QueryError", () => Effect.succeed(true))
            ),
            true
        );
    }
    assert.strictEqual(
        yield* make({ prefix: "x; DROP TABLE party_tables_rows" }).pipe(
            Effect.as(false),
            Effect.catchReason("OntologyStorageError", "ConfigurationError", () => Effect.succeed(true))
        ),
        true
    );
    yield* tables.delete(table, hostile);
    assert.deepEqual(yield* tables.get(table, "safe"), { [hostile]: "safe", n: 3, other: 2 });
});

test("SQLite treats hostile names, payloads, and predicates as data", async () => {
    await Effect.runPromise(
        check("sqlite").pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })))
    );
}, 30000);
test("PostgreSQL remains safe with nonstandard backslash strings", async () => {
    await Effect.runPromise(check("pg").pipe(Effect.provide(PgliteClient.layer())));
}, 30000);
