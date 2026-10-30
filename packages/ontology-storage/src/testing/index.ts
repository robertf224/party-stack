/** Shared backend conformance program; also usable by additional driver implementations. */
import { Effect, Exit } from "effect";
import { Temporal } from "temporal-polyfill";
import { overlay, loadVisible, getVisible, putVisible, deleteVisible } from "../overlay/index.js";
import { applyQuery } from "../query/evaluate.js";
import { Table, field, where, type Query, type Row } from "../table-api.js";
import type { TablesService, Transaction } from "../tables.js";

const assert = (value: unknown, message: string): void => {
    if (!value) throw new Error(message);
};
interface Task {
    title: string;
    project: number;
    rank: number;
    email: string;
}
export const runContract = Effect.fnUntraced(function* (tables: TablesService) {
    // A late codec failure must clean up an unpublished, partially built index.
    // Retry with a different array field under the same name to expose stale entries.
    type BackfillRow = { id: number; oldTags: string[]; newTags: string[] };
    let rejectBackfill = false;
    const backfill = Table.make<BackfillRow>({
        name: "streamed-index-backfill",
        codec: {
            encode: (row) => row,
            decode: (value) => {
                const row = value as BackfillRow;
                if (rejectBackfill && row.id === 299) throw new Error("Late backfill decode failure");
                return row;
            },
        },
    });
    yield* tables.transaction((tx) =>
        Effect.gen(function* () {
            for (let id = 0; id < 300; id++)
                yield* tx.put(backfill, id, { id, oldTags: ["old"], newTags: ["new"] });
        })
    );
    yield* tables.transaction((tx) =>
        Effect.gen(function* () {
            rejectBackfill = true;
            const failed = yield* Effect.exit(
                tx.ensureIndex(backfill, { name: "retry-array", field: field("oldTags"), multiEntry: true })
            );
            rejectBackfill = false;
            assert(Exit.isFailure(failed), "Expected a late index-backfill codec failure");
            yield* tx.ensureIndex(backfill, {
                name: "retry-array",
                field: field("newTags"),
                multiEntry: true,
            });
        })
    );
    assert(
        (yield* tables.query(backfill, { where: where.contains(field("newTags"), "old") })).length === 0,
        "Failed build must remove partial entries/projections before a same-name retry"
    );
    assert(
        (yield* tables.query(backfill, { where: where.contains(field("newTags"), "new") })).length === 300,
        "Successful retry must index rows across all scan batches"
    );
    const arrays = Table.make<{
        title: string;
        tags?: readonly (string | number | boolean | null | undefined)[];
    }>({ name: "array-membership" });
    for (const [key, value] of [
        ["a", { title: "unrelated", tags: ["urgent", "urgent", "other"] }],
        ["b", { title: "Urgent title", tags: ["other"] }],
        ["c", { title: "unrelated" }],
        ["d", { title: "unrelated", tags: [] }],
        ["e", { title: "unrelated", tags: [null, undefined, 1, true, "1", "'); DROP TABLE rows; --"] }],
    ] as const)
        yield* tables.put(arrays, key, value);
    assert(
        (yield* tables.query(arrays, { where: where.contains(field("tags"), "urgent") }))
            .map((row) => row.key)
            .join() === "a",
        "Unindexed array membership"
    );
    yield* tables.ensureIndex(arrays, { name: "tags'quoted", field: field("tags"), multiEntry: true });
    yield* tables.ensureIndex(arrays, { name: "title", field: field("title") });
    for (const needle of ["urgent", "1", 1, true, null, undefined, "'); DROP TABLE rows; --"] as const) {
        const query = { where: where.contains(field("tags"), needle) };
        const actual = yield* tables.query(arrays, query);
        assert(
            actual.map((row) => row.key).join() === (needle === "urgent" ? "a" : "e"),
            "Typed array membership and hostile literal safety"
        );
    }
    const search = where.or(where.ilike(field("title"), "urgent%"), where.contains(field("tags"), "urgent"));
    assert(
        (yield* tables.query(arrays, { where: search })).map((row) => row.key).join() === "a,b",
        "Search retains title-only and label-only matches"
    );
    assert(
        (yield* tables.query(arrays, { where: search, offset: 1, limit: 1 })).map((row) => row.key).join() ===
            "b",
        "Array search pagination follows the whole OR"
    );
    yield* tables.put(arrays, "a", { title: "unrelated", tags: [] });
    assert(
        (yield* tables.query(arrays, { where: where.contains(field("tags"), "urgent") })).length === 0,
        "Empty replacement releases prior array index entries"
    );
    yield* tables.delete(arrays, "e");
    assert(
        (yield* tables.query(arrays, { where: where.contains(field("tags"), 1) })).length === 0,
        "Deleting rows releases array index entries"
    );
    assert(
        Exit.isFailure(
            yield* Effect.exit(tables.ensureIndex(arrays, { name: "tags'quoted", field: field("tags") }))
        ),
        "Array index semantics cannot silently change"
    );
    const nullable = Table.make<{ rank?: number | null }>({ name: "nullable-order" });
    for (const [key, value] of [
        ["a", { rank: null }],
        ["b", {}],
        ["c", { rank: null }],
        ["d", { rank: 2 }],
        ["e", { rank: 1 }],
    ] as const)
        yield* tables.put(nullable, key, value);
    yield* tables.ensureIndex(nullable, { name: "rank", field: field("rank") });
    for (const [direction, nulls, expected] of [
        ["asc", "first", "a,b,c,e,d"],
        ["desc", "first", "a,b,c,d,e"],
        ["asc", "last", "e,d,a,b,c"],
        ["desc", "last", "d,e,a,b,c"],
    ] as const) {
        const orderBy = [{ field: field("rank"), direction, nulls }];
        const rows = yield* tables.query(nullable, { orderBy });
        assert(
            rows.map((row) => row.key).join(",") === expected,
            "Explicit nullish placement and stable key ties"
        );
        const first = rows[0]!;
        const page = yield* tables.query(nullable, {
            orderBy,
            after: { values: [first.value.rank], key: first.key },
            limit: 2,
        });
        assert(
            page.map((row) => row.key).join(",") ===
                rows
                    .slice(1, 3)
                    .map((row) => row.key)
                    .join(","),
            "Keyset pagination through nullish ordering ties"
        );
    }
    const tasks = Table.make<Task>({ name: "tasks" });
    const meta = Table.make<unknown>({ name: "metadata" });
    const all: Row<Task>[] = Array.from({ length: 140 }, (_, i) => ({
        key: i,
        value: {
            title: `Task ${String(i).padStart(3, "0")}`,
            project: i % 4,
            rank: i % 17,
            email: `${i}@test`,
        },
    }));
    yield* tables.transaction((tx) =>
        Effect.gen(function* () {
            for (const row of all) yield* tx.put(tasks, row.key, row.value);
            yield* tx.ensureIndex(tasks, { name: "rank", field: field("rank") });
            yield* tx.ensureIndex(tasks, { name: "project", field: field("project") });
            yield* tx.ensureIndex(tasks, { name: "title", field: field("title") });
            yield* tx.ensureIndex(tasks, { name: "email", field: field("email"), unique: true });
            assert(
                (yield* tx.query(tasks, { where: where.eq(field("project"), 2) })).length === 35,
                "Index build inside transaction"
            );
            yield* tx.put(meta, "cursor", 123n);
            assert((yield* tx.get(meta, "cursor")) === 123n, "Cross-table read-your-writes");
        })
    );
    const queries: Query[] = [
        {},
        { where: where.eq(2, field("project")) },
        { where: where.lt(4, field("rank")) },
        { where: where.gte(field("project"), field("rank")) },
        { where: where.eq("title", "title") },
        { where: where.eq("title", field("title")) },
        { where: where.like("Task 001", field("title")) },
        { where: where.ilike(field("title"), field("title")) },
        { where: where.in(1, [1, 2]) },
        { where: where.in(1, []) },
        { where: where.eq(field("missing"), field("otherMissing")) },
        { where: where.eq(field("project"), 2) },
        { where: where.and(where.gte(field("rank"), 4), where.lt(field("rank"), 9)) },
        { where: where.or(where.eq(field("project"), 1), where.eq(field("rank"), 7)) },
        { where: where.or(where.eq(field("project"), 1), where.eq(field("email"), "5@test")) },
        { where: where.and(where.eq(field("project"), 1), where.eq(field("rank"), 99)) },
        { where: where.or() },
        { where: where.and() },
        { where: where.in(field("project"), []) },
        { where: where.not(where.eq(field("project"), 1)) },
        { where: where.like(field("title"), "Task 01%") },
        { orderBy: [{ field: field("rank") }], limit: 13, offset: 7 },
        { orderBy: [{ field: field("rank"), direction: "desc" }], limit: 13, offset: 7 },
        { where: where.eq(field("project"), 3), orderBy: [{ field: field("rank") }], limit: 11 },
        { orderBy: [{ field: field("rank") }, { field: field("title"), direction: "desc" }], limit: 5 },
        { orderBy: [{ field: field("rank") }], after: { values: [9], key: 60 }, limit: 15 },
        { where: where.like(field("title"), "Task 01_") },
        { where: where.ilike(field("title"), "tASK 01%") },
        { where: where.ilike(field("title"), "%1_") },
        { where: where.not(where.ilike(field("title"), "task 01%")) },
        {
            where: where.or(where.ilike(field("title"), "tASK 01%"), where.eq(field("missing"), undefined)),
        },
        {
            where: where.and(where.gte(field("rank"), 8), where.lte(field("rank"), 10)),
            orderBy: [{ field: field("rank"), direction: "desc" }],
            after: { values: [9], key: 60 },
            limit: 15,
        },
        {
            where: where.gte(field("rank"), 10),
            orderBy: [{ field: field("rank") }],
            after: { values: [2], key: 60 },
            limit: 15,
        },
        {
            where: where.gt(field("rank"), 10),
            orderBy: [{ field: field("rank") }],
            after: { values: [10], key: 60 },
            limit: 15,
        },
        {
            where: where.lt(field("rank"), 10),
            orderBy: [{ field: field("rank") }],
            after: { values: [12], key: 60 },
            limit: 15,
        },
        {
            orderBy: [{ field: field("rank"), direction: "desc" }],
            after: { values: [9], key: 60 },
            limit: 15,
        },
        { limit: 0 },
    ];
    for (const query of queries) {
        const result = yield* tables.query(tasks, query);
        assert(
            Table.make<unknown>({ name: "oracle" }).encode(result) ===
                Table.make<unknown>({ name: "oracle" }).encode(applyQuery(all, query)),
            `Query differs from oracle: ${JSON.stringify(query)}`
        );
    }
    const failed = yield* Effect.exit(
        tables.transaction((tx) =>
            Effect.gen(function* () {
                yield* tx.delete(tasks, 0);
                yield* tx.put(meta, "cursor", 999n);
                yield* tx.put(tasks, "new", { title: "bad", project: 9, rank: 9, email: "1@test" });
            })
        )
    );
    assert(Exit.isFailure(failed), "Unique violation must fail");
    const conflict = yield* tables
        .put(tasks, "conflict", { title: "bad", project: 1, rank: 1, email: "1@test" })
        .pipe(
            Effect.as("unexpected"),
            Effect.catchReason("OntologyStorageError", "UniqueConstraint", (reason) =>
                Effect.succeed(`${reason.table}/${reason.index}`)
            )
        );
    assert(conflict === "tasks/email", "Unique constraints expose typed table/index details");
    const invalidQuery = yield* tables.query(tasks, { limit: -1 }).pipe(
        Effect.as(false),
        Effect.catchReason("OntologyStorageError", "QueryError", () => Effect.succeed(true))
    );
    assert(invalidQuery, "Query errors can be handled by reason");
    assert((yield* tables.get(tasks, 0))?.email === "0@test", "Row deletion rolled back");
    assert((yield* tables.get(meta, "cursor")) === 123n, "Cross-table rollback");
    assert(
        (yield* tables.query(tasks, { where: where.eq(field("email"), "1@test") })).length === 1,
        "Indexes rolled back"
    );
    yield* tables.transaction((tx) =>
        Effect.gen(function* () {
            yield* tx.put(tasks, 0, { ...all[0]!.value, project: 8, rank: -1 });
            assert(
                (yield* tx.query(tasks, { where: where.eq(field("project"), 8) }))[0]?.key === 0,
                "Indexes see transaction writes"
            );
            yield* tx.delete(tasks, 0);
            assert(
                (yield* tx.query(tasks, { where: where.eq(field("project"), 8) })).length === 0,
                "Index entries removed"
            );
            yield* tx.put(tasks, 0, all[0]!.value);
        })
    );
    const defect = yield* Effect.exit(
        tables.transaction((tx) =>
            Effect.gen(function* () {
                yield* tx.delete(tasks, 1);
                yield* Effect.yieldNow;
                yield* Effect.sleep(1);
                yield* Effect.die("defect");
            })
        )
    );
    assert(Exit.isFailure(defect) && !!(yield* tables.get(tasks, 1)), "Defects roll back");
    const interrupted = yield* Effect.exit(
        tables.transaction((tx) =>
            Effect.gen(function* () {
                yield* tx.delete(tasks, 1);
                yield* Effect.interrupt;
            })
        )
    );
    assert(Exit.isFailure(interrupted) && !!(yield* tables.get(tasks, 1)), "Interruption rolls back");
    let escaped: Transaction | undefined;
    yield* tables.transaction((tx) =>
        Effect.sync(() => {
            escaped = tx;
        })
    );
    assert(
        Exit.isFailure(yield* Effect.exit(escaped!.put(tasks, "escaped", all[0]!.value))),
        "Escaped transaction rejected"
    );
    const input = {
        nested: [{ flag: true, missing: undefined, amount: -(2n ** 200n) }],
        big: -(2n ** 200n),
        date: new Date("2026-01-01"),
        instant: Temporal.Instant.from("2026-01-01T00:00:00.123456789Z"),
        day: Temporal.PlainDate.from("2026-02-03"),
        map: new Map([["x", { marker: true }]]),
        set: new Set([1n, 2n]),
        tag: { tag: "bigint", value: "application data" },
    };
    yield* tables.put(meta, "rich", input);
    const rich = (yield* tables.get(meta, "rich")) as typeof input;
    assert(rich.big === input.big && rich.nested[0]?.amount === input.big, "Nested bigint survives");
    assert(Object.hasOwn(rich.nested[0]!, "missing"), "Nested undefined survives");
    assert(
        String(rich.instant) === String(input.instant) && String(rich.day) === String(input.day),
        "Temporal survives"
    );
    assert(rich.date instanceof Date && rich.date.getTime() === input.date.getTime(), "Date survives");
    assert(rich.map.get("x")?.marker && rich.set.has(2n), "Map and Set survive");
    assert(rich.tag.value === "application data", "Application tags cannot collide");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const unsupported of [cycle, new Uint8Array([1])]) {
        assert(
            yield* tables.put(meta, "unsupported", unsupported).pipe(
                Effect.as(false),
                Effect.catchReason("OntologyStorageError", "CodecError", () => Effect.succeed(true))
            ),
            "Unsupported graph/binary values are typed codec errors"
        );
    }
    yield* tables.put(meta, "__proto__", Object.fromEntries([["__proto__", { safe: true }]]));
    assert(
        Object.hasOwn((yield* tables.get(meta, "__proto__")) as object, "__proto__"),
        "Prototype-named fields survive"
    );
    assert(
        Exit.isFailure(yield* Effect.exit(tables.put(meta, "bad", () => {}))),
        "Unsupported functions fail"
    );
    const scalars = Table.make<{ value: unknown }>({ name: "scalars" });
    const values = [
        undefined,
        null,
        false,
        true,
        -99,
        0,
        1.5,
        -(2n ** 200n),
        -1n,
        0n,
        2n ** 200n,
        new Date(0),
        "",
        "a",
        "a\u0000",
        "a\uffff",
        Temporal.Instant.from("1969-01-01T00:00:00Z"),
        Temporal.Instant.from("2026-01-01T00:00:00Z"),
        Temporal.PlainDate.from("-000001-01-01"),
        Temporal.PlainDate.from("2026-01-01"),
    ];
    yield* tables.transaction((tx) =>
        Effect.gen(function* () {
            for (let i = 0; i < values.length; i++) yield* tx.put(scalars, i, { value: values[i] });
            yield* tx.ensureIndex(scalars, { name: "value", field: field("value") });
        })
    );
    const ordered = yield* tables.query(scalars, {
        orderBy: [{ field: field("value") }],
        limit: 100,
    });
    assert(
        ordered.map((row) => row.key).join() === values.map((_, i) => i).join(),
        "Portable scalar index order"
    );
    const view = overlay(tasks, { name: "optimistic" });
    yield* tables.transaction((tx) =>
        Effect.gen(function* () {
            yield* deleteVisible(tx, view, 0);
            yield* putVisible(tx, view, 2, { ...all[2]!.value, project: 1, rank: -20 });
            yield* putVisible(tx, view, 1, { ...all[1]!.value, project: 3, rank: 100 });
            yield* putVisible(tx, view, "insert", { title: "new", project: 1, rank: -30, email: "new" });
            assert((yield* getVisible(tx, view, 0)) === undefined, "Tombstone shadows base");
            const oracle = [
                ...all.filter((row) => ![0, 1, 2].includes(row.key as number)),
                { key: 2, value: { ...all[2]!.value, project: 1, rank: -20 } },
                { key: 1, value: { ...all[1]!.value, project: 3, rank: 100 } },
                { key: "insert", value: { title: "new", project: 1, rank: -30, email: "new" } },
            ];
            for (const query of queries) {
                const actual = yield* loadVisible(tx, view, query);
                assert(
                    Table.make<unknown>({ name: "oracle" }).encode(actual) ===
                        Table.make<unknown>({ name: "oracle" }).encode(applyQuery(oracle, query)),
                    `Overlay differs from oracle: ${JSON.stringify(query)}`
                );
            }
        })
    );
    yield* tables.read((tx) =>
        Effect.gen(function* () {
            assert(
                (yield* loadVisible(tx, view, { limit: 2 })).length === 2,
                "Overlay works in read snapshots"
            );
        })
    );
    yield* tables.transaction((tx) =>
        Effect.gen(function* () {
            // A caught validation error must not damage existing rows or indexes.
            yield* Effect.exit(tx.put(tasks, 1, { ...all[1]!.value, email: "2@test" }));
            assert(
                (yield* tx.query(tasks, { where: where.eq(field("email"), "1@test") }))[0]?.key === 1,
                "Caught uniqueness error preserves indexes"
            );
            yield* Effect.exit(
                tx.ensureIndex(tasks, { name: "bad_unique", field: field("project"), unique: true })
            );
            assert((yield* tx.query(tasks)).length === 140, "Caught index build error preserves rows");
            yield* tx.put(meta, "undefined", undefined);
            yield* tx.ensureIndex(meta, { name: "missing", field: field("missing") });
            assert(
                (yield* tx.query(meta, { orderBy: [{ field: field("missing") }], limit: 20 })).some(
                    (row) => row.key === "undefined"
                ),
                "Ordered indexes include undefined row values"
            );
            yield* tx.clear(scalars);
            assert((yield* tx.query(scalars)).length === 0, "Clear removes all rows and entries");
            yield* tx.put(scalars, "new", { value: 2n });
            assert(
                (yield* tx.query(scalars, { where: where.eq(field("value"), 2n) }))[0]?.key === "new",
                "Clear preserves index definitions"
            );
        })
    );
    const nested = yield* Effect.exit(tables.withTransaction(tables.transaction(() => Effect.void)));
    assert(Exit.isFailure(nested), "Accidental nested top-level calls fail instead of deadlocking");
    const composed = yield* tables.withTransaction(tables.get(tasks, 1));
    assert(composed?.email === "1@test", "Service calls reuse the contextual transaction");
    const ambientRollback = yield* Effect.exit(
        tables.withTransaction(
            Effect.gen(function* () {
                yield* tables.put(meta, "ambient", "must roll back");
                yield* Effect.fail("rollback");
            })
        )
    );
    assert(
        Exit.isFailure(ambientRollback) && (yield* tables.get(meta, "ambient")) === undefined,
        "Contextual transaction rollback"
    );
    assert(
        Exit.isFailure(yield* Effect.exit(tables.withReadTransaction(tables.put(meta, "readonly", 1)))),
        "Contextual read-only guard"
    );
    const counter = Table.make<number>({ name: "counter" });
    yield* tables.put(counter, "key", 0);
    const increment = tables.transaction((tx) =>
        Effect.gen(function* () {
            const value = yield* tx.get(counter, "key");
            yield* Effect.yieldNow;
            yield* tx.put(counter, "key", (value ?? 0) + 1);
        })
    );
    yield* Effect.all(
        Array.from({ length: 12 }, () => increment),
        { concurrency: 4 }
    );
    assert(
        (yield* tables.get(counter, "key")) === 12,
        "Concurrent transactions serialize without lost updates"
    );
});

export { runOntologyContract } from "./ontology.js";
export { runBlobContract } from "./blobs.js";
