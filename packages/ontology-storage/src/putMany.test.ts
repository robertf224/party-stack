import { it } from "@effect/vitest";
import { Arbitrary, Cause, Effect, Exit, Schema, Tracer } from "effect";
import { expect, test } from "vitest";
import { codecError, indexError } from "./errors.js";
import { make } from "./memory/tables.js";
import { Table, field, eq, contains, type Table as TableType } from "./model.js";
import { scalarKey } from "./query/evaluate.js";
import type { Transaction } from "./tables.js";

type Value = { email: string; aliases: string[]; group: number; bad?: boolean };
type Batch = readonly { key: string; value: Value }[];
const initial: Batch = [0, 1, 2].map((i) => ({
    key: `k${i}`,
    value: { email: `e${i}`, aliases: [`t${i}`], group: i % 2 },
}));
const summary = <A, E>(exit: Exit.Exit<A, E>) => {
    if (Exit.isSuccess(exit)) return { kind: "success" };
    const error = Cause.squash(exit.cause) as {
        operation?: string;
        reason?: { _tag?: string };
        message?: string;
    };
    return {
        kind: "failure",
        operation: error?.operation,
        reason: error?.reason?._tag,
        message: error?.message ?? String(error),
    };
};
// Independent sequential oracle: validate every new value before any row write,
// then use ordinary put in input order. Generated index fields are typed scalars.
const sequential = Effect.fnUntraced(function* (tx: Transaction, table: TableType<Value>, rows: Batch) {
    for (const row of rows) {
        const data = yield* Effect.try({
            try: () => table.encode(row.value),
            catch: (cause) => codecError("encode", cause),
        });
        const value = yield* Effect.try({
            try: () => table.decode(data),
            catch: (cause) => codecError("decode", cause),
        });
        yield* Effect.try({
            try: () => {
                scalarKey(value.email);
                scalarKey(value.aliases[0]);
                scalarKey(value.group);
                value.aliases.forEach(scalarKey);
            },
            catch: (cause) => indexError("Index values must be queryable scalars", cause),
        });
    }
    for (const row of rows) yield* tx.put(table, row.key, row.value);
});
const scenario = Effect.fnUntraced(function* (
    bulk: boolean,
    batch: Batch,
    caught = true,
    rollback = false,
    lateFailure = false
) {
    const tables = yield* make();
    let rejectOld = false;
    const inspect = Table.make<Value>({ name: "rows" });
    const table = Table.make<Value>({
        name: "rows",
        codec: {
            encode: (v) => v,
            decode: (v) => {
                if (rejectOld && (v as Value).bad) throw new Error("Old row decode failed");
                return v as Value;
            },
        },
    });
    yield* tables.ensureIndex(table, { name: "email", field: field("email"), unique: true });
    yield* tables.ensureIndex(table, { name: "aliases", field: field("aliases"), multiEntry: true });
    yield* tables.ensureIndex(table, { name: "first-alias", field: field("aliases", "0"), unique: true });
    yield* tables.ensureIndex(table, { name: "group", field: field("group") });
    for (const row of initial)
        yield* tables.put(table, row.key, {
            ...row.value,
            ...(lateFailure && row.key === "k1" ? { bad: true } : {}),
        });
    rejectOld = lateFailure;
    const outer = yield* Effect.exit(
        tables.transaction((tx) =>
            Effect.gen(function* () {
                const result = yield* Effect.exit(
                    bulk ? tx.putMany(table, batch) : sequential(tx, table, batch)
                );
                const inside = yield* tx.query(inspect);
                if (!caught && Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
                if (rollback) return yield* Effect.fail("explicit rollback");
                return { outcome: summary(result), inside };
            })
        )
    );
    const final = yield* tables.query(inspect);
    const lookups = [];
    for (const email of new Set([...initial, ...batch].map((row) => row.value.email)))
        lookups.push(yield* tables.query(inspect, { where: eq(field("email"), email) }));
    const aliases = [];
    for (const alias of new Set([...initial, ...batch].flatMap((row) => row.value.aliases)))
        aliases.push(yield* tables.query(inspect, { where: contains(field("aliases"), alias) }));
    return {
        outer: summary(outer),
        inside: Exit.isSuccess(outer) ? outer.value : undefined,
        final,
        lookups,
        aliases,
    };
});
const generator = Arbitrary.schema(
    Schema.Struct({
        input: Schema.Array(
            Schema.Struct({
                key: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
                email: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
                alias: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
                empty: Schema.Boolean,
            })
        ),
        caught: Schema.Boolean,
        rollback: Schema.Boolean,
    })
);
it.effect.prop(
    "unique bulk writes match an independent sequential oracle",
    [generator],
    ([input]) =>
        Effect.gen(function* () {
            const rows = input.input.map((v) => ({
                key: `k${v.key}`,
                value: {
                    email: `e${v.email}`,
                    aliases: v.empty ? [] : [`t${v.alias}`, `t${v.alias}`],
                    group: v.key % 2,
                },
            }));
            const expected = yield* scenario(false, rows, input.caught, input.rollback);
            const actual = yield* scenario(true, rows, input.caught, input.rollback);
            expect(actual).toEqual(expected);
        }),
    { arbitrary: { runs: 300, size: 8, seed: "portable-unique-batch-v1" } }
);

test("portable unique batch preserves conflicts, vacancy chains, duplicates and caught prefixes", async () => {
    const cases: Batch[] = [
        [
            { key: "x", value: { email: "new", aliases: ["new"], group: 0 } },
            { key: "y", value: { email: "e0", aliases: ["other"], group: 0 } },
            { key: "z", value: { email: "later", aliases: [], group: 0 } },
        ],
        [
            { key: "k0", value: { email: "new", aliases: ["new"], group: 0 } },
            { key: "x", value: { email: "e0", aliases: ["t0"], group: 1 } },
        ],
        [
            { key: "x", value: { email: "new", aliases: ["new"], group: 0 } },
            { key: "y", value: { email: "new", aliases: ["different"], group: 1 } },
        ],
        [
            { key: "k0", value: { email: "new", aliases: [], group: 0 } },
            { key: "k0", value: { email: "last", aliases: ["last"], group: 1 } },
        ],
        [
            { key: "k0", value: { email: "e1", aliases: ["t1"], group: 0 } },
            { key: "k1", value: { email: "e0", aliases: ["t0"], group: 1 } },
        ],
        Array.from({ length: 260 }, (_, i) => ({
            key: `new-${i}`,
            value: { email: `new-${i}`, aliases: [`new-${i}`, `new-${i}`], group: i % 2 },
        })),
    ];
    for (const rows of cases)
        expect(await Effect.runPromise(scenario(true, rows))).toEqual(
            await Effect.runPromise(scenario(false, rows))
        );
});

test("a caught previous-row decoder failure preserves the sequential successful prefix", async () => {
    const rows: Batch = [
        { key: "k0", value: { email: "changed-0", aliases: ["changed-0"], group: 0 } },
        { key: "k1", value: { email: "changed-1", aliases: ["changed-1"], group: 1 } },
        { key: "k2", value: { email: "changed-2", aliases: ["changed-2"], group: 0 } },
    ];
    const expected = await Effect.runPromise(scenario(false, rows, true, false, true));
    const actual = await Effect.runPromise(scenario(true, rows, true, false, true));
    expect(actual).toEqual(expected);
    expect(actual.final.map((row) => row.value.email)).toEqual(["changed-0", "e1", "e2"]);
});

test("large bulk diagnostics distinguish independent writes from ordered fallbacks without row data", async () => {
    const spans: Tracer.NativeSpan[] = [];
    const tracer = Tracer.make({
        span(options) {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
        },
    });
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* make();
            const table = Table.make<{ email: string }>({ name: "private-table-name" });
            yield* tables.ensureIndex(table, { name: "email", field: field("email"), unique: true });
            const rows = Array.from({ length: 65 }, (_, i) => ({
                key: `private-key-${i}`,
                value: { email: `private-value-${i}` },
            }));
            yield* tables.putMany(table, rows);
            yield* Effect.exit(
                tables.putMany(
                    table,
                    rows.map((row, i) => ({
                        ...row,
                        value: { email: i === 1 ? "private-value-0" : row.value.email },
                    }))
                )
            );
            yield* tables.putMany(table, rows.slice(0, 2));
        }).pipe(Effect.provideService(Tracer.Tracer, tracer))
    );
    const attributes = (name: string) =>
        spans.filter((span) => span.name === name).map((span) => Object.fromEntries(span.attributes));
    expect(attributes("Tables.putMany")).toEqual([
        { rows: 65, indexes: 1, concurrency: 128, state: "independent-unique" },
        { rows: 65, indexes: 1, concurrency: 1, state: "sequential" },
    ]);
    expect(attributes("Tables.putMany.proof")).toEqual([
        { uniqueSlots: 65, uniqueProbes: 65, reason: "independent" },
        { uniqueSlots: 1, reason: "duplicate-slots" },
    ]);
    expect(attributes("Tables.putMany.write").map((value) => value.concurrency)).toEqual([128, 1]);
    expect(attributes("Tables.putMany.write").every((value) => Number(value.peakWrites) >= 1)).toBe(true);
    expect(spans.filter((span) => span.name === "Tables.putMany.prepare")).toHaveLength(2);
    expect(JSON.stringify(spans.map((span) => Object.fromEntries(span.attributes)))).not.toContain("private");
});
