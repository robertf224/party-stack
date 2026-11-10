import { it } from "@effect/vitest";
import { Arbitrary, Effect, Exit, Schema, Stream } from "effect";
import { Temporal } from "temporal-polyfill";
import { expect, test } from "vitest";
import { Table, and, eq, field, gte, inArray, or } from "../model.js";
import { applyQuery, cursorOf, decodeKey, keyCode, readField, scalarKey } from "../query/evaluate.js";
import { queryRows } from "./index.js";
import type { DriverTransaction, Entry, Range, StoredIndex } from "../driver/index.js";
import type { Query, Row, Scalar, ValueCodec } from "../model.js";

interface Value {
    readonly leading?: Scalar;
    readonly secondary?: Scalar;
    readonly third: number;
    readonly keep: boolean;
    readonly label: string;
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const fixture = (
    values: readonly Row<Value>[],
    names: readonly (keyof Value)[] = ["leading"],
    codec?: ValueCodec<Value>
) => {
    const table = Table.make<Value>({ name: "ordered-window", codec });
    const stored = values.map((row) => ({
        table: table.name,
        key: keyCode(row.key),
        data: table.encode(row.value),
    }));
    const canonical = stored.map((row) => ({ key: decodeKey(row.key), value: table.decode(row.data) }));
    const byKey = new Map(stored.map((row) => [row.key, row]));
    const indexes: StoredIndex[] = names.map((name) => ({
        table: table.name,
        name,
        version: 1,
        field: field(name),
    }));
    const indexed = new Map(
        indexes.map((index) => [
            index.name,
            canonical
                .map((row): Entry => ({
                    table: table.name,
                    index: index.name,
                    key: keyCode(row.key),
                    value: scalarKey(readField(row.value, index.field)),
                }))
                .sort((a, b) => compare(a.value, b.value) || compare(a.key, b.key)),
        ])
    );
    const stats = { hydrated: 0, entries: 0, calls: 0, reads: new Set<string>() };
    const window = (index: string, range: Range = {}) => {
        const selected = indexed.get(index)!.filter((entry) => {
            if (
                range.lower !== undefined &&
                (entry.value < range.lower || (range.lowerOpen && entry.value === range.lower))
            )
                return false;
            if (
                range.upper !== undefined &&
                (entry.value > range.upper || (range.upperOpen && entry.value === range.upper))
            )
                return false;
            if (range.after) {
                const order = compare(entry.value, range.after.value) || compare(entry.key, range.after.key);
                if (range.direction === "desc" ? order >= 0 : order <= 0) return false;
            }
            return true;
        });
        return range.direction === "desc" ? selected.reverse() : selected;
    };
    const unused = () => Effect.die("Unexpected write in read-only planner fixture.");
    const raw: DriverTransaction = {
        query: (selected, available, query) => queryRows(raw, selected, available, query),
        get: (_table, key) =>
            Effect.sync(() => {
                stats.hydrated++;
                return byKey.get(key);
            }),
        rows: () => Effect.succeed(stored),
        scanRows: () => Stream.fromIterable(stored),
        indexes: () => Effect.succeed(indexes),
        countEntries: (_table, index, range) => Effect.sync(() => window(index, range).length),
        entries: (_table, index, range = {}) =>
            Effect.sync(() => {
                const result = window(index, range).slice(0, range.limit);
                stats.calls++;
                stats.entries += result.length;
                stats.reads.add(index);
                return result;
            }),
        clear: unused,
        put: unused,
        delete: unused,
        putIndex: unused,
        putEntry: unused,
        deleteEntries: unused,
    };
    const read = (query: Query) =>
        queryRows(raw, table, indexes, query).pipe(
            Effect.map(
                (result) =>
                    result.decodedRows ??
                    result.rows.map((row) => ({ key: decodeKey(row.key), value: table.decode(row.data) }))
            )
        );
    return { read, stats, canonical };
};
const values = (count: number): Row<Value>[] =>
    Array.from({ length: count }, (_, n) => ({
        key: `key-${String(n).padStart(5, "0")}`,
        value: { leading: n, secondary: count - n, third: n % 11, keep: true, label: `label-${n}` },
    }));
const scalars: readonly Scalar[] = [
    undefined,
    null,
    false,
    true,
    -10,
    0,
    0.5,
    9n,
    new Date("2025-01-01T00:00:00Z"),
    "",
    "a",
    "z",
    Temporal.Instant.from("2026-11-09T12:00:00Z"),
    Temporal.PlainDate.from("2026-11-09"),
];

test("one scalar DESC order reads an arbitrarily large tie by ascending key without hydrating the tie", async () => {
    const f = fixture(values(1447).map((row) => ({ ...row, value: { ...row.value, leading: 1 } })));
    const query: Query = { orderBy: [{ field: field("leading"), direction: "desc" }], limit: 51 };
    expect(await Effect.runPromise(f.read(query))).toEqual(applyQuery(f.canonical, query));
    expect(f.stats.hydrated).toBe(51);
    expect(f.stats.entries).toBe(128 + 51);
    expect(f.stats.calls).toBe(2);
});

test("scalar pages sort complete small ties together without one index read per timestamp", async () => {
    const f = fixture(values(1447).map((row, n) => ({ ...row, value: { ...row.value, leading: n >> 2 } })));
    const query: Query = {
        orderBy: [{ field: field("leading"), direction: "desc", nulls: "first" }],
        offset: 3,
        limit: 51,
    };
    expect(await Effect.runPromise(f.read(query))).toEqual(applyQuery(f.canonical, query));
    expect(f.stats.hydrated).toBe(54);
    expect(f.stats.entries).toBe(128);
    expect(f.stats.calls).toBe(2); // Empty nullish group plus one leading page.
});

test("scalar exact-boundary buckets preserve mixed keys, residuals, offsets and every cursor page", async () => {
    const f = fixture(
        values(520).map((row, n) => ({
            key: n % 3 ? row.key : n - 260,
            value: { ...row.value, leading: n < 30 ? 3 : n < 400 ? 2 : 1, keep: n % 5 === 0 },
        }))
    );
    for (const direction of ["asc", "desc"] as const) {
        const query: Query = {
            where: eq(field("keep"), true),
            orderBy: [{ field: field("leading"), direction }],
            offset: 2,
            limit: 7,
        };
        let scan = query;
        for (let page = 0; page < 20; page++) {
            const rows = await Effect.runPromise(f.read(scan));
            expect(rows).toEqual(applyQuery(f.canonical, scan));
            if (!rows.length) break;
            scan = { ...query, after: cursorOf(rows.at(-1)!, query) };
        }
    }
});

test("scalar bounds never loosen a predicate at a cursor outside the allowed range", async () => {
    const f = fixture(values(400));
    for (const direction of ["asc", "desc"] as const)
        for (const leading of [-10, 10, 100, 450]) {
            const query: Query = {
                where: and(gte(field("leading"), 100), eq(field("keep"), true)),
                orderBy: [{ field: field("leading"), direction }],
                after: { values: [leading], key: "missing" },
                offset: 4,
                limit: 17,
            };
            expect(await Effect.runPromise(f.read(query))).toEqual(applyQuery(f.canonical, query));
        }
});

test("a bounded scalar bucket reuses canonical codecs and fails atomically on an invalid selected row", async () => {
    let reject = false;
    let decodes = 0;
    const f = fixture(
        values(400).map((row) => ({ ...row, value: { ...row.value, leading: 1 } })),
        ["leading"],
        {
            encode: (row) => row,
            decode: (input) => {
                const row = input as Value;
                decodes++;
                if (reject && row.label === "label-3") throw new Error("Invalid canonical row");
                return { ...row, label: row.label.toUpperCase() };
            },
        }
    );
    decodes = 0;
    const query: Query = { orderBy: [{ field: field("leading"), direction: "desc" }], limit: 7 };
    expect(await Effect.runPromise(f.read(query))).toEqual(applyQuery(f.canonical, query));
    expect(decodes).toBe(7);
    reject = true;
    expect(await Effect.runPromise(f.read(query).pipe(Effect.flip))).toMatchObject({
        reason: { _tag: "CodecError", direction: "decode" },
    });
});

test("a bounded composite window reads only a leading prefix instead of every index map", async () => {
    const f = fixture(values(1447), ["leading", "secondary", "keep"]);
    const query: Query = {
        where: eq(field("keep"), true),
        orderBy: [{ field: field("leading"), direction: "desc" }, { field: field("secondary") }],
        limit: 51,
    };
    expect(await Effect.runPromise(f.read(query))).toEqual(applyQuery(f.canonical, query));
    expect([...f.stats.reads]).toEqual(["leading"]);
    expect(f.stats.entries).toBe(129);
    expect(f.stats.hydrated).toBe(128);
});

test("broad indexed leading ties keep map selection and decode only the requested rows", async () => {
    const f = fixture(
        values(1447).map((row, n) => ({ ...row, value: { ...row.value, leading: n % 2 === 0 } })),
        ["leading", "secondary", "keep"]
    );
    const query: Query = {
        where: eq(field("keep"), true),
        orderBy: [{ field: field("leading"), direction: "desc" }, { field: field("secondary") }],
        offset: 3,
        limit: 51,
    };
    expect(await Effect.runPromise(f.read(query))).toEqual(applyQuery(f.canonical, query));
    expect(f.stats.hydrated).toBe(54);
    expect(f.stats.reads.has("secondary")).toBe(true);
});

test("a singleton first value does not cause a later large indexed tie to be hydrated", async () => {
    const f = fixture(
        values(1447).map((row, n) => ({ ...row, value: { ...row.value, leading: n ? 1 : 2 } })),
        ["leading", "secondary", "keep"]
    );
    const query: Query = {
        where: eq(field("keep"), true),
        orderBy: [{ field: field("leading"), direction: "desc" }, { field: field("secondary") }],
        limit: 51,
    };
    expect(await Effect.runPromise(f.read(query))).toEqual(applyQuery(f.canonical, query));
    expect(f.stats.hydrated).toBe(51);
});

test("residuals can trigger fallback after one bounded page without hydrating the later tie", async () => {
    const f = fixture(
        values(1447).map((row, n) => ({
            ...row,
            value: { ...row.value, leading: n < 70 ? 1000 - n : 1, keep: n >= 70 },
        })),
        ["leading", "secondary", "keep"]
    );
    const query: Query = {
        where: eq(field("keep"), true),
        orderBy: [{ field: field("leading"), direction: "desc" }, { field: field("secondary") }],
        limit: 51,
    };
    expect(await Effect.runPromise(f.read(query))).toEqual(applyQuery(f.canonical, query));
    expect(f.stats.hydrated).toBe(128 + 51);
});

test("unindexed secondary ordering gathers complete descending ties across pages", async () => {
    const f = fixture(
        values(401).map((row, n) => ({
            key: n % 2 ? n : row.key,
            value: { ...row.value, leading: true, secondary: scalars[n % scalars.length] },
        }))
    );
    for (const offset of [0, 125, 399]) {
        const query: Query = {
            orderBy: [
                { field: field("leading"), direction: "desc" },
                { field: field("secondary"), direction: "desc", nulls: "last" },
            ],
            offset,
            limit: 17,
        };
        expect(await Effect.runPromise(f.read(query))).toEqual(applyQuery(f.canonical, query));
    }
});

test("explicit null ordering merges absent and null values before the full cursor and secondary sort", async () => {
    const f = fixture(
        values(390).map((row, n) => ({
            key: n % 2 ? n : row.key,
            value: {
                ...(n % 2 ? { leading: null } : {}),
                secondary: 390 - n,
                third: row.value.third,
                keep: row.value.keep,
                label: row.value.label,
            },
        }))
    );
    for (const direction of ["asc", "desc"] as const)
        for (const nulls of ["first", "last"] as const)
            for (const cursorValue of [undefined, null]) {
                const query: Query = {
                    orderBy: [{ field: field("leading"), direction, nulls }, { field: field("secondary") }],
                    after: { values: [cursorValue, 150], key: "missing-cursor" },
                    offset: 13,
                    limit: 51,
                };
                expect(await Effect.runPromise(f.read(query))).toEqual(applyQuery(f.canonical, query));
            }
});

test("canonical decoder values are reused and decode failures produce no partial query result", async () => {
    let reject = false;
    let decodes = 0;
    const f = fixture(values(260), ["leading"], {
        encode: (value) => value,
        decode: (input) => {
            decodes++;
            const value = input as Value;
            if (reject && value.leading === 200) throw new Error("Rejected canonical row");
            return { ...value, label: value.label.toUpperCase() };
        },
    });
    decodes = 0;
    const query: Query = {
        orderBy: [{ field: field("leading"), direction: "desc" }, { field: field("label") }],
        limit: 7,
    };
    expect(await Effect.runPromise(f.read(query))).toEqual(applyQuery(f.canonical, query));
    expect(decodes).toBe(f.stats.hydrated);
    reject = true;
    const error = await Effect.runPromise(f.read(query).pipe(Effect.flip));
    expect(error.reason).toMatchObject({ _tag: "CodecError", direction: "decode" });
});

test("zero windows and invalid cursor schemas do not read or decode an index page", async () => {
    const f = fixture(values(260));
    const orderBy: Query["orderBy"] = [{ field: field("leading") }, { field: field("secondary") }];
    expect(await Effect.runPromise(f.read({ orderBy, limit: 0 }))).toEqual([]);
    expect(
        Exit.isFailure(
            await Effect.runPromiseExit(f.read({ orderBy, limit: 7, after: { values: [], key: "missing" } }))
        )
    ).toBe(true);
    expect(f.stats.entries).toBe(0);
    expect(f.stats.hydrated).toBe(0);
});

const generator = Arbitrary.schema(
    Schema.Struct({
        codes: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: scalars.length - 1 }))),
        descending: Schema.Boolean,
        secondaryDescending: Schema.Boolean,
        nulls: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
        secondaryNulls: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
        offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 330 })),
        limit: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 51 })),
        cursor: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 310 })),
        missingKey: Schema.Boolean,
        predicate: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
    })
);
it.effect.prop(
    "bounded composite plans match an independent full-filter/full-sort oracle",
    [generator],
    ([input]) =>
        Effect.gen(function* () {
            const f = fixture(
                values(311).map((row, n) => ({
                    key: n % 3 ? row.key : n,
                    value: {
                        ...(n % 17
                            ? { leading: scalars[input.codes[n % input.codes.length] ?? n % scalars.length] }
                            : {}),
                        secondary: scalars[(n * 3 + 1) % scalars.length],
                        third: row.value.third,
                        keep: n % 4 !== 0,
                        label: row.value.label,
                    },
                }))
            );
            const query: Query = {
                orderBy: [
                    {
                        field: field("leading"),
                        direction: input.descending ? "desc" : "asc",
                        nulls: input.nulls === 0 ? undefined : input.nulls === 1 ? "first" : "last",
                    },
                    {
                        field: field("secondary"),
                        direction: input.secondaryDescending ? "desc" : "asc",
                        nulls:
                            input.secondaryNulls === 0
                                ? undefined
                                : input.secondaryNulls === 1
                                  ? "first"
                                  : "last",
                    },
                    { field: field("third") },
                ],
                where: [
                    undefined,
                    and(gte(field("leading"), null), eq(field("keep"), true)),
                    inArray(field("leading"), [undefined, null, false, "a"]),
                    or(eq(field("keep"), false), eq(field("third"), 5)),
                ][input.predicate],
                offset: input.offset,
                limit: input.limit,
            };
            const cursor = cursorOf(f.canonical[input.cursor]!, query);
            for (const scan of [
                query,
                { ...query, after: { ...cursor, key: input.missingKey ? "missing" : cursor.key } },
            ])
                expect(yield* f.read(scan)).toEqual(applyQuery(f.canonical, scan));
        }),
    // Full-filter/full-sort oracle comparisons need more than the unit-test budget on shared CI CPUs.
    { arbitrary: { runs: 160, size: 8, seed: "bounded-leading-window-v1" }, timeout: 30_000 }
);

it.effect.prop(
    "scalar windows match full-sort oracle for null placement, heterogeneous values and missing cursor keys",
    [generator],
    ([input]) =>
        Effect.gen(function* () {
            const f = fixture(
                values(311).map((row, n) => ({
                    key: n % 3 ? row.key : n - 155,
                    value: {
                        ...row.value,
                        leading: scalars[input.codes[n % input.codes.length] ?? n % scalars.length],
                        keep: n % 4 !== 0,
                    },
                }))
            );
            const query: Query = {
                orderBy: [
                    {
                        field: field("leading"),
                        direction: input.descending ? "desc" : "asc",
                        nulls: input.nulls === 0 ? undefined : input.nulls === 1 ? "first" : "last",
                    },
                ],
                where: [
                    undefined,
                    and(gte(field("leading"), null), eq(field("keep"), true)),
                    inArray(field("leading"), [undefined, null, false, "a"]),
                    or(eq(field("keep"), false), eq(field("third"), 5)),
                ][input.predicate],
                offset: input.offset,
                limit: input.limit,
            };
            const cursor = cursorOf(f.canonical[input.cursor]!, query);
            for (const scan of [
                query,
                {
                    ...query,
                    after: { ...cursor, key: input.missingKey ? "missing" : cursor.key },
                },
            ])
                expect(yield* f.read(scan)).toEqual(applyQuery(f.canonical, scan));
        }),
    { arbitrary: { runs: 160, size: 8, seed: "bounded-scalar-window-v1" }, timeout: 30_000 }
);
