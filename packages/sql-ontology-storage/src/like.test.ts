import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import {
    Table,
    applyQuery,
    eq,
    field,
    ilike,
    like,
    not,
    or,
    type Query,
} from "@party-stack/ontology-storage/tables";
import { Arbitrary, Effect, Schema } from "effect";
import { expect, test } from "vitest";
import { compileQuery } from "./compiler.js";
import { make } from "./tables.js";

test.each(["sqlite", "pg"] as const)(
    "%s native folded projections preserve mixed-value NOT ILIKE and OR across writes and backfill",
    async (dialect) => {
        await Effect.runPromise(
            Effect.gen(function* () {
                const tables = yield* make();
                for (const backfill of [false, true]) {
                    const table = Table.make<{ name: unknown; n: number }>({
                        name: `mixed-folded-${backfill ? "backfill" : "writes"}`,
                    });
                    const data = [
                        undefined,
                        null,
                        false,
                        true,
                        0,
                        2.5,
                        7n,
                        "",
                        "Alpha",
                        "aLPine",
                        "beta",
                    ].map((name, n) => ({ key: String(n).padStart(2, "0"), value: { name, n } }));
                    const index = { name: "name", field: field("name") };
                    if (!backfill) yield* tables.ensureIndex(table, index);
                    yield* tables.putMany(table, data);
                    if (backfill) yield* tables.ensureIndex(table, index);
                    yield* tables.ensureIndex(table, { name: "n", field: field("n") });
                    const verify = Effect.gen(function* () {
                        const positive = ilike(field("name"), "al%");
                        const queries: Query[] = [
                            { where: not(positive) },
                            { where: or(positive, eq(field("name"), true)) },
                            { where: or(not(positive), eq(field("name"), "Alpha")) },
                            {
                                where: not(positive),
                                orderBy: [{ field: field("n") }],
                                offset: 1,
                                limit: 4,
                            },
                        ];
                        for (const query of queries)
                            expect(yield* tables.query(table, query)).toEqual(applyQuery(data, query));
                    });
                    yield* verify;
                    // Cover both folded-placeholder replacement and removal of a
                    // prior string projection, then repeat the independent oracle.
                    data[0] = { ...data[0]!, value: { name: "Albatross", n: 0 } };
                    yield* tables.put(table, data[0].key, data[0].value);
                    data[8] = { ...data[8]!, value: { name: 42, n: 8 } };
                    yield* tables.put(table, data[8].key, data[8].value);
                    yield* verify;
                }
            }).pipe(
                Effect.provide(
                    dialect === "sqlite" ? SqliteClient.layer({ filename: ":memory:" }) : PgliteClient.layer()
                )
            )
        );
    },
    30000
);

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

            const unit = Schema.Literals([
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
                "\n",
            ]);
            const text = Arbitrary.map(
                Arbitrary.schema(Schema.Array(unit).check(Schema.isMaxLength(9))),
                (units) => units.join("")
            );
            const value = Arbitrary.flatMap(
                Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 }))),
                (kind): Arbitrary.Arbitrary<unknown> =>
                    kind === 0
                        ? text
                        : kind === 1
                          ? Arbitrary.Constant(null)
                          : kind === 2
                            ? Arbitrary.Constant(undefined)
                            : Arbitrary.schema(
                                  kind === 3
                                      ? Schema.Boolean
                                      : Schema.Int.check(Schema.isBetween({ minimum: -2, maximum: 2 }))
                              )
            );
            const propertyResult = yield* Arbitrary.checkEffect(
                Arbitrary.all([
                    Arbitrary.array(value, { maxLength: 25 }),
                    text,
                    Arbitrary.schema(Schema.Boolean),
                    Arbitrary.schema(Schema.Boolean),
                ]),
                ([values, pattern, insensitive, negated]) =>
                    Effect.gen(function* () {
                        const data = values.map((name, n) => ({ key: String(n), value: { name, n } }));
                        yield* tables.transaction((tx) =>
                            Effect.gen(function* () {
                                yield* tx.clear(table);
                                for (const row of data) yield* tx.put(table, row.key, row.value);
                            })
                        );
                        const predicate = (insensitive ? ilike : like)(field("name"), pattern);
                        const scan: Query = {
                            where: negated ? not(predicate) : predicate,
                            orderBy: [{ field: field("n") }],
                            offset: 1,
                            limit: 3,
                        };
                        expect(yield* tables.query(table, scan)).toEqual(applyQuery(data, scan));
                    }).pipe(Effect.as(true), Effect.catchDefect(Effect.fail)),
                { runs: 90 }
            );
            expect(Arbitrary.formatCheckFailure(propertyResult)).toBeUndefined();
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
