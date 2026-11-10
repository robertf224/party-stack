import { it } from "@effect/vitest";
import { Arbitrary, Deferred, Effect, Exit, Fiber, Schema } from "effect";
import { expect, test } from "vitest";
import { keyCode } from "../query/evaluate.js";
import { Table, contains, eq, field, gte, type Key } from "../table-api.js";
import * as Memory from "./tables.js";
import type { Transaction } from "../tables.js";

interface Value {
    readonly rank: number;
    readonly group: number;
    readonly tags: readonly string[];
}
const initial = Array.from({ length: 260 }, (_, n) => ({
    key: n % 3 ? `key-${n}` : n,
    value: { rank: n, group: n % 7, tags: [`tag-${n % 11}`, `tag-${n % 13}`, `tag-${n % 11}`] },
}));
const sort = (rows: ReadonlyMap<Key, Value>) =>
    [...rows]
        .map(([key, value]) => ({ key, value }))
        .sort((a, b) => (keyCode(a.key) < keyCode(b.key) ? -1 : keyCode(a.key) > keyCode(b.key) ? 1 : 0));
const setup = Effect.fnUntraced(function* (unique = false) {
    const tables = yield* Memory.make();
    const table = Table.make<Value>({ name: "cow-rows" });
    for (const name of ["rank", "group"])
        yield* tables.ensureIndex(table, { name, field: field(name), unique: name === "rank" && unique });
    yield* tables.ensureIndex(table, { name: "tags", field: field("tags"), multiEntry: true });
    yield* tables.putMany(table, initial);
    return { tables, table };
});

test("failed transactions discard row, ordered-index and reverse-entry roots together", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const { tables, table } = yield* setup();
            const before = yield* tables.query(table);
            const failed = yield* Effect.exit(
                tables.transaction((tx) =>
                    Effect.gen(function* () {
                        for (const row of initial.slice(0, 200)) yield* tx.delete(table, row.key);
                        yield* tx.put(table, "new", { rank: -1, group: -1, tags: ["new", "new"] });
                        return yield* Effect.fail("abort after index merges");
                    })
                )
            );
            expect(Exit.isFailure(failed)).toBe(true);
            expect(yield* tables.query(table)).toEqual(before);
            expect(yield* tables.query(table, { where: contains(field("tags"), "new") })).toEqual([]);
            expect(yield* tables.query(table, { where: contains(field("tags"), "tag-3") })).toEqual(
                before.filter((row) => row.value.tags.includes("tag-3"))
            );
            yield* tables
                .clear(table)
                .pipe(
                    Effect.andThen(Effect.fail("rollback clear")),
                    (effect) => tables.withTransaction(effect),
                    Effect.exit
                );
            expect(yield* tables.query(table)).toEqual(before);
        })
    );
});

test("caught uniqueness errors preserve successful prefixes without mutating the earlier committed view", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const { tables, table } = yield* setup(true);
            const before = yield* tables.query(table);
            yield* tables.transaction((tx) =>
                Effect.gen(function* () {
                    yield* tx.put(table, "prefix", { rank: 300, group: 8, tags: ["prefix"] });
                    const rejected = yield* Effect.exit(
                        tx.put(table, "conflict", { rank: 0, group: 8, tags: ["rejected"] })
                    );
                    expect(Exit.isFailure(rejected)).toBe(true);
                })
            );
            expect(yield* tables.query(table, { where: contains(field("tags"), "prefix") })).toEqual([
                { key: "prefix", value: { rank: 300, group: 8, tags: ["prefix"] } },
            ]);
            expect(yield* tables.query(table, { where: contains(field("tags"), "rejected") })).toEqual([]);
            expect(before).toEqual(sort(new Map(initial.map((row) => [row.key, row.value]))));
            let closed: Transaction | undefined;
            yield* tables.transaction((tx) =>
                Effect.sync(() => {
                    closed = tx;
                })
            );
            const error = yield* closed!.get(table, 0).pipe(Effect.flip);
            expect(error.reason).toMatchObject({ _tag: "TransactionError", kind: "Closed" });
        })
    );
});

test("interrupting after working-root edits releases the gate and restores the committed view", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { tables, table } = yield* setup();
                const before = yield* tables.query(table);
                const entered = yield* Deferred.make<void>();
                const writer = yield* Effect.forkChild(
                    tables.transaction((tx) =>
                        Effect.gen(function* () {
                            for (const row of initial.slice(0, 200)) yield* tx.delete(table, row.key);
                            yield* tx.put(table, "interrupted", { rank: -1, group: -1, tags: ["new"] });
                            yield* Deferred.succeed(entered, undefined);
                            return yield* Effect.never;
                        })
                    )
                );
                yield* Deferred.await(entered);
                yield* Fiber.interrupt(writer);
                expect(yield* tables.query(table)).toEqual(before);
                expect(yield* tables.query(table, { where: contains(field("tags"), "new") })).toEqual([]);
            })
        )
    );
});

test("large and duplicate multi-entry memberships match the row oracle through replacement and deletion", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const { tables, table } = yield* setup();
            const oracle = new Map<Key, Value>(initial.map((row) => [row.key, row.value]));
            const tags = Array.from({ length: 2048 }, (_, n) => `large-${n}`);
            const large = { rank: 5000, group: 8, tags: [...tags, tags[0]!, tags.at(-1)!] };
            const neighbor = { rank: 6000, group: 8, tags: ["large-0", "tail", "tail"] };
            yield* tables.putMany(table, [
                { key: "large", value: large },
                { key: "neighbor", value: neighbor },
            ]);
            oracle.set("large", large);
            oracle.set("neighbor", neighbor);
            const check = Effect.fnUntraced(function* () {
                const rows = sort(oracle);
                for (const tag of ["large-0", "large-100", "large-2047", "tail", "absent"])
                    expect(yield* tables.query(table, { where: contains(field("tags"), tag) })).toEqual(
                        rows.filter((row) => row.value.tags.includes(tag))
                    );
            });
            yield* check();
            const replacement = { rank: 5001, group: 8, tags: ["large-100", "large-100", "tail"] };
            yield* tables.put(table, "large", replacement);
            oracle.set("large", replacement);
            yield* check();
            yield* tables.delete(table, "large");
            oracle.delete("large");
            yield* check();
            yield* tables.clear(table);
            expect(yield* tables.query(table, { where: contains(field("tags"), "tail") })).toEqual([]);
        })
    );
});

const generator = Arbitrary.schema(
    Schema.Struct({
        operations: Schema.Array(
            Schema.Struct({
                kind: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
                key: Schema.Int.check(Schema.isBetween({ minimum: -10, maximum: 300 })),
                numericKey: Schema.Boolean,
                rank: Schema.Int.check(Schema.isBetween({ minimum: -30, maximum: 300 })),
                tag: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 14 })),
            })
        ),
        rollback: Schema.Boolean,
        group: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
        after: Schema.Int.check(Schema.isBetween({ minimum: -10, maximum: 300 })),
        limit: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30 })),
        descending: Schema.Boolean,
    })
);
it.effect.prop(
    "transactional row/index edits agree with an independent Map+sort oracle",
    [generator],
    ([input]) =>
        Effect.gen(function* () {
            const { tables, table } = yield* setup();
            const expected = new Map<Key, Value>(initial.map((row) => [row.key, row.value]));
            const operations = input.operations.map((operation) => ({
                ...operation,
                key: operation.numericKey ? operation.key : `key-${operation.key}`,
                value: {
                    rank: operation.rank,
                    group: Math.abs(operation.rank % 7),
                    tags: [`tag-${operation.tag}`, `tag-${operation.tag}`, `tag-${(operation.tag + 1) % 15}`],
                },
            }));
            yield* tables
                .transaction((tx) =>
                    Effect.gen(function* () {
                        for (const operation of operations) {
                            if (operation.kind === 0) yield* tx.put(table, operation.key, operation.value);
                            else if (operation.kind === 1) yield* tx.delete(table, operation.key);
                            else yield* tx.clear(table);
                        }
                        if (input.rollback) return yield* Effect.fail("generated rollback");
                    })
                )
                .pipe(Effect.exit);
            if (!input.rollback)
                for (const operation of operations) {
                    if (operation.kind === 0) expected.set(operation.key, operation.value);
                    else if (operation.kind === 1) expected.delete(operation.key);
                    else expected.clear();
                }
            const rows = sort(expected);
            expect(yield* tables.query(table)).toEqual(rows);
            expect(yield* tables.keys(table, { after: input.after, limit: input.limit })).toEqual(
                rows
                    .filter((row) => keyCode(row.key) > keyCode(input.after))
                    .slice(0, input.limit)
                    .map((row) => row.key)
            );
            expect(
                yield* tables.query(table, { where: eq(field("group"), input.group), limit: input.limit })
            ).toEqual(rows.filter((row) => row.value.group === input.group).slice(0, input.limit));
            for (const tag of ["tag-0", "tag-7", "tag-14"])
                expect(yield* tables.query(table, { where: contains(field("tags"), tag) })).toEqual(
                    rows.filter((row) => row.value.tags.includes(tag))
                );
            const ranked = rows
                .filter((row) => row.value.rank >= 0)
                .sort(
                    (a, b) =>
                        (input.descending ? b.value.rank - a.value.rank : a.value.rank - b.value.rank) ||
                        (keyCode(a.key) < keyCode(b.key) ? -1 : keyCode(a.key) > keyCode(b.key) ? 1 : 0)
                );
            expect(
                yield* tables.query(table, {
                    where: gte(field("rank"), 0),
                    orderBy: [{ field: field("rank"), direction: input.descending ? "desc" : "asc" }],
                    limit: input.limit,
                })
            ).toEqual(ranked.slice(0, input.limit));
        }),
    // Each generated case rebuilds 260 rows and three indexes; keep the full oracle workload on CI.
    { arbitrary: { runs: 100, size: 12, seed: "memory-cow-transactions-v1" }, timeout: 30_000 }
);
