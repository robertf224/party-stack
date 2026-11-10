import { Effect, Schema, Stream } from "effect";
import { Temporal } from "temporal-polyfill";
import { expect, test } from "vitest";
import { make as makeMemory } from "./memory/tables.js";
import { Table, eq, field, gte, gt } from "./model.js";
import { decodeKey, keyCode } from "./query/evaluate.js";
import { makeTables } from "./tables.js";
import type { DriverTransaction, StoredRow } from "./driver/index.js";
import type { Query } from "./model.js";

test("filtered query results reuse the same decoded values across every planner path", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* makeMemory();
            let decodes = 0;
            type Value = {
                id: string;
                active: boolean;
                n: number;
                group: number;
                label: string;
                at: Temporal.Instant;
            };
            const rows = Table.make<Value>({
                name: "single-decode",
                codec: {
                    encode: (value) => value,
                    decode: (input) => {
                        decodes++;
                        const value = input as Value;
                        return { ...value, label: value.label.toUpperCase() };
                    },
                },
            });
            const at = Temporal.Instant.from("2026-11-09T12:00:00Z");
            const values = Array.from({ length: 260 }, (_, n) => ({
                id: String(n).padStart(3, "0"),
                active: true,
                n,
                group: n % 5,
                label: `label-${n % 9}`,
                at,
            }));
            yield* tables.putMany(
                rows,
                values.map((value) => ({ key: value.id, value }))
            );
            for (const name of ["active", "n", "group"])
                yield* tables.ensureIndex(rows, { name, field: field(name) });
            const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
            const cases: { query: Query; expected: typeof values; decodes: number }[] = [
                {
                    query: { where: eq(field("active"), true), limit: 7 },
                    expected: values.slice(0, 7),
                    decodes: 7,
                },
                { query: { where: gte(field("n"), 0), limit: 7 }, expected: values.slice(0, 7), decodes: 7 },
                {
                    query: { orderBy: [{ field: field("n"), direction: "desc" }], limit: 7 },
                    expected: [...values].reverse().slice(0, 7),
                    decodes: 7,
                },
                {
                    query: {
                        where: eq(field("active"), true),
                        orderBy: [
                            { field: field("group"), direction: "desc", nulls: "first" },
                            { field: field("n"), nulls: "first" },
                        ],
                        limit: 7,
                    },
                    expected: [...values].sort((a, b) => b.group - a.group || a.n - b.n).slice(0, 7),
                    decodes: 7,
                },
                {
                    query: {
                        where: eq(field("active"), true),
                        orderBy: [{ field: field("label") }],
                        limit: 7,
                    },
                    expected: [...values]
                        .sort((a, b) => compare(a.label, b.label) || compare(a.id, b.id))
                        .slice(0, 7),
                    decodes: values.length,
                },
            ];
            for (const item of cases) {
                decodes = 0;
                const result = yield* tables.query(rows, item.query);
                expect(result.map((row) => row.value)).toEqual(
                    item.expected.map((value) => ({ ...value, label: value.label.toUpperCase() }))
                );
                expect(result.every((row) => row.value.at.toString() === at.toString())).toBe(true);
                expect(decodes).toBe(item.decodes);
                result[0]!.value.label = "mutated";
                result.splice(0);
            }
            expect((yield* tables.get(rows, "000"))?.label).toBe("LABEL-0");
        })
    );
});

const rawTables = (stored: readonly StoredRow[], complete: boolean, carryDecoded = false) => {
    const unused = () => Effect.die("Unexpected write in native query fixture.");
    const raw: DriverTransaction = {
        query: (table) =>
            Effect.sync(() => ({
                rows: stored,
                complete,
                ...(carryDecoded
                    ? {
                          decodedRows: stored.map((row) => ({
                              key: decodeKey(row.key),
                              value: table.decode(row.data),
                          })),
                      }
                    : {}),
            })),
        get: () => Effect.succeed(undefined),
        rows: () => Effect.succeed(stored),
        scanRows: () => Stream.fromIterable(stored),
        indexes: () => Effect.succeed([]),
        entries: () => Effect.succeed([]),
        countEntries: () => Effect.succeed(0),
        clear: unused,
        put: unused,
        delete: unused,
        putIndex: unused,
        putEntry: unused,
        deleteEntries: unused,
    };
    return makeTables({ transaction: (_mode, body) => body(raw) });
};

test.each([false, true])(
    "native candidates still apply residual query semantics (decoded=%s)",
    async (carryDecoded) => {
        await Effect.runPromise(
            Effect.gen(function* () {
                let decodes = 0;
                const rows = Table.make<{ n: number }>({
                    name: "native-candidates",
                    codec: {
                        encode: (value) => value,
                        decode: (value) => {
                            decodes++;
                            return value as { n: number };
                        },
                    },
                });
                const stored = [2, 5, 0, 3, 4, 1].map((n) => ({
                    table: rows.name,
                    key: keyCode(n),
                    data: rows.encode({ n }),
                }));
                const tables = rawTables(stored, false, carryDecoded);
                expect(
                    yield* tables.query(rows, {
                        where: gt(field("n"), 1),
                        orderBy: [{ field: field("n"), direction: "desc" }],
                        offset: 1,
                        limit: 2,
                    })
                ).toEqual([
                    { key: 4, value: { n: 4 } },
                    { key: 3, value: { n: 3 } },
                ]);
                expect(decodes).toBe(stored.length);
            })
        );
    }
);

test("raw native rows cannot bypass table codec validation", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const schema = Schema.Struct({ n: Schema.Finite });
            const rows = Table.make({
                name: "validated-native",
                codec: { encode: Schema.encodeSync(schema), decode: Schema.decodeUnknownSync(schema) },
            });
            const untyped = Table.make({ name: rows.name });
            const tables = rawTables(
                [{ table: rows.name, key: keyCode("bad"), data: untyped.encode({ n: "not-a-number" }) }],
                true
            );
            expect(yield* Effect.result(tables.query(rows))).toMatchObject({
                _tag: "Failure",
                failure: { operation: "decode", reason: { _tag: "CodecError", direction: "decode" } },
            });
        })
    );
});

test("key enumeration falls back to exact ordinary queries for custom drivers", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const table = Table.make<number>({ name: "fallback-keys" });
            const stored = ["z", 10, -2, "a", 1].map((key) => ({
                table: table.name,
                key: keyCode(key),
                data: table.encode(0),
            }));
            const tables = rawTables(stored, false);
            expect(yield* tables.keys(table, { after: 1, limit: 2 })).toEqual([10, "a"]);
            expect(yield* tables.keys(table, { after: "missing", limit: 2 })).toEqual(["z"]);
            expect(yield* tables.keys(table, { limit: 0 })).toEqual([]);
        })
    );
});
