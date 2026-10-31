import * as PgliteClient from "@effect/sql-pglite/PgLiteClient";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { Table, applyQuery, field, ilike, like, not, type Query } from "@party-stack/ontology-storage/tables";
import { Effect } from "effect";
import fc from "fast-check";
import { expect, test } from "vitest";
import { compileQuery } from "./compiler.js";
import { make } from "./tables.js";

test.each(["sqlite", "pg"] as const)(
    "%s LIKE pushdown preserves UTF-16, case folding, escaping and pagination",
    async (dialect) => {
        const program = Effect.gen(function* () {
            const tables = yield* make();
            const table = Table.make<{ name: unknown; n: number }>({ name: "native-like" });
            const indexes = ["name", "n"].map((name) => ({
                name,
                field: field(name),
                table: table.name,
                version: 1,
            }));
            for (const index of indexes) yield* tables.ensureIndex(table, index);
            yield* tables.put(table, "new", { name: "urgent investigation", n: 100 });
            yield* tables.put(table, "old", { name: "urgent work done", n: 90 });
            const query: Query = {
                where: like(field("name"), "urgent%done"),
                orderBy: [{ field: field("n"), direction: "desc" }],
                limit: 1,
            };
            const plan = compileQuery(dialect, indexes, query);
            expect(plan.complete).toBe(true);
            expect(plan.pagination).toContain("LIMIT");
            expect(
                compileQuery(dialect, indexes, { where: like(field("name"), "%a".repeat(180)) }).complete
            ).toBe(false);
            expect((yield* tables.query(table, query)).map((row) => row.key)).toEqual(["old"]);
            expect(compileQuery(dialect, indexes, { where: like(field("name"), "%a%b%") }).complete).toBe(
                dialect === "pg"
            );

            const unit = fc.constantFrom(
                "a",
                "A",
                "é",
                "É",
                "İ",
                "ß",
                "😀",
                "\ud800",
                "%",
                "_",
                "\\",
                "[",
                ".",
                "'",
                "\n"
            );
            const text = fc.array(unit, { maxLength: 9 }).map((units) => units.join(""));
            const value = fc.oneof(
                text,
                fc.constant(null),
                fc.constant(undefined),
                fc.boolean(),
                fc.integer({ min: -2, max: 2 })
            );
            const context = yield* Effect.context<never>();
            const run = Effect.runPromiseWith(context);
            yield* Effect.promise(() =>
                fc.assert(
                    fc.asyncProperty(
                        fc.array(value, { maxLength: 25 }),
                        text,
                        fc.boolean(),
                        fc.boolean(),
                        async (values, pattern, insensitive, negated) => {
                            const data = values.map((name, n) => ({ key: String(n), value: { name, n } }));
                            await run(
                                tables.transaction((tx) =>
                                    Effect.gen(function* () {
                                        yield* tx.clear(table);
                                        for (const row of data) yield* tx.put(table, row.key, row.value);
                                    })
                                )
                            );
                            const predicate = (insensitive ? ilike : like)(field("name"), pattern);
                            const scan: Query = {
                                where: negated ? not(predicate) : predicate,
                                orderBy: [{ field: field("n") }],
                                offset: 1,
                                limit: 3,
                            };
                            expect(await run(tables.query(table, scan))).toEqual(applyQuery(data, scan));
                        }
                    ),
                    { numRuns: 90 }
                )
            );
        });
        await Effect.runPromise(
            program.pipe(
                Effect.provide(
                    dialect === "sqlite" ? SqliteClient.layer({ filename: ":memory:" }) : PgliteClient.layer()
                )
            )
        );
    },
    60000
);
