import { it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { Temporal } from "temporal-polyfill";
import { expect } from "vitest";
import { make as makeMemory } from "./memory/tables.js";
import { Table, field, ilike, not, or, eq, type Predicate, type Scalar } from "./model.js";
import { caseInsensitiveIndex, keyCode, scalarKey } from "./query/evaluate.js";
import { makeTables } from "./tables.js";
import type { DriverTransaction, Entry, StoredIndex, StoredRow } from "./driver/index.js";

// Records physical mutations at the portable-driver boundary, independently of
// Memory's persistent data structures. Queries use the real Memory driver below.
function writeRecorder(nativeWrite: boolean, nativeIndexes = false) {
    const rows = new Map<string, StoredRow>();
    const definitions = new Map<string, StoredIndex>();
    const entries = new Map<string, Entry>();
    const identity = (entry: Entry) => JSON.stringify([entry.index, entry.value, entry.key]);
    const put = (entry: Entry) => entries.set(identity(entry), entry);
    const unused = () => Effect.die("Unexpected query in write-count fixture.");
    const raw: DriverTransaction = {
        nativeIndexes,
        query: unused,
        entries: unused,
        countEntries: unused,
        get: (_table, key) => Effect.sync(() => rows.get(key)),
        rows: () => Effect.sync(() => [...rows.values()]),
        scanRows: () => Stream.suspend(() => Stream.fromIterable(rows.values())),
        indexes: () => Effect.sync(() => [...definitions.values()]),
        putIndex: (index) =>
            Effect.sync(() => {
                definitions.set(index.name, index);
            }),
        put: (row) =>
            Effect.sync(() => {
                rows.set(row.key, row);
            }),
        putEntry: (entry) =>
            Effect.sync(() => {
                put(entry);
            }),
        delete: (_table, key) =>
            Effect.sync(() => {
                rows.delete(key);
            }),
        clear: () =>
            Effect.sync(() => {
                rows.clear();
                entries.clear();
            }),
        deleteEntries: (_table, index, key) =>
            Effect.sync(() => {
                for (const [identity, entry] of entries)
                    if (entry.index === index && (key === undefined || entry.key === key))
                        entries.delete(identity);
            }),
        ...(nativeWrite
            ? {
                  writeRow: (row: StoredRow, remove: readonly Entry[], insert: readonly Entry[]) =>
                      Effect.sync(() => {
                          rows.set(row.key, row);
                          for (const entry of remove) entries.delete(identity(entry));
                          for (const entry of insert) put(entry);
                      }),
              }
            : {}),
    };
    return { tables: makeTables({ transaction: (_mode, body) => body(raw) }), rows, entries, put };
}

const values: readonly Scalar[] = [
    undefined,
    null,
    false,
    true,
    0,
    2.5,
    7n,
    new Date("2026-01-01T00:00:00Z"),
    Temporal.Instant.from("2026-01-01T00:00:00Z"),
    Temporal.PlainDate.from("2026-01-01"),
    "",
    "Alpha",
    "aLPine",
    "beta",
];

it.effect("native row projections retain non-string folded sentinels for SQL negation", () =>
    Effect.gen(function* () {
        const { tables, rows } = writeRecorder(true, true);
        const table = Table.make<{ value: Scalar }>({ name: "native-folded" });
        yield* tables.ensureIndex(table, { name: "value", field: field("value") });
        yield* tables.putMany(
            table,
            values.map((value, key) => ({ key, value: { value } }))
        );
        for (const [key, value] of values.entries()) {
            expect(rows.get(keyCode(key))?.indexValues).toEqual({
                value: scalarKey(value),
                [caseInsensitiveIndex("value")]: scalarKey(
                    typeof value === "string" ? value.toLowerCase() : undefined
                ),
            });
        }
    })
);

it.effect.each([false, true])(
    "folded indexes contain only strings across writes and backfill (nativeWrite=%s)",
    (nativeWrite) =>
        Effect.gen(function* () {
            for (const backfill of [false, true]) {
                const { tables, entries, put } = writeRecorder(nativeWrite);
                const table = Table.make<{ value: Scalar }>({ name: "sparse-folded" });
                const index = { name: "value", field: field("value") };
                if (!backfill) yield* tables.ensureIndex(table, index);
                yield* tables.putMany(
                    table,
                    values.map((value, key) => ({ key, value: { value } }))
                );
                if (backfill) yield* tables.ensureIndex(table, index);
                const folded = () =>
                    [...entries.values()].filter((entry) => entry.index === caseInsensitiveIndex(index.name));
                expect(entries.size).toBe(
                    values.length + values.filter((value) => typeof value === "string").length
                );
                expect(
                    folded()
                        .map((entry) => entry.value)
                        .sort()
                ).toEqual(
                    values
                        .filter((value): value is string => typeof value === "string")
                        .map((value) => scalarKey(value.toLowerCase()))
                        .sort()
                );
                // A database created by the previous implementation may still have
                // this unreachable placeholder; replacing its row removes it.
                put({
                    table: table.name,
                    index: caseInsensitiveIndex(index.name),
                    key: keyCode(0),
                    value: scalarKey(undefined),
                });
                yield* tables.put(table, 0, { value: "ALbatross" });
                expect(
                    folded()
                        .filter((entry) => entry.key === keyCode(0))
                        .map((entry) => entry.value)
                ).toEqual([scalarKey("albatross")]);
                yield* tables.put(table, 0, { value: 100 });
                expect(folded().some((entry) => entry.key === keyCode(0))).toBe(false);
            }
        })
);

it.effect("sparse folded indexes preserve mixed-value prefix, negation and wildcard queries", () =>
    Effect.gen(function* () {
        const tables = yield* makeMemory();
        const table = Table.make<{ value: Scalar }>({ name: "folded-query" });
        yield* tables.putMany(
            table,
            values.map((value, key) => ({ key, value: { value } }))
        );
        yield* tables.ensureIndex(table, { name: "value", field: field("value") });
        const matches = (value: Scalar) => typeof value === "string" && value.toLowerCase().startsWith("al");
        const expected = (predicate: (value: Scalar) => boolean) =>
            values.flatMap((value, key) => (predicate(value) ? [key] : []));
        const keys = (where: Predicate) =>
            tables.query(table, { where }).pipe(Effect.map((rows) => rows.map((row) => row.key)));
        expect(yield* keys(ilike(field("value"), "AL%"))).toEqual(expected(matches));
        expect(yield* keys(not(ilike(field("value"), "AL%")))).toEqual(expected((value) => !matches(value)));
        expect(yield* keys(or(ilike(field("value"), "AL%"), eq(field("value"), true)))).toEqual(
            expected((value) => matches(value) || value === true)
        );
        expect(yield* keys(ilike(field("value"), "%"))).toEqual(
            expected((value) => typeof value === "string")
        );
        yield* tables.put(table, 0, { value: "Alphabet" });
        expect(yield* keys(ilike(field("value"), "AL%"))).toEqual([0, ...expected(matches)]);
        yield* tables.put(table, 0, { value: null });
        expect(yield* keys(ilike(field("value"), "AL%"))).toEqual(expected(matches));
    })
);
