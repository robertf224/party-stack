import { evaluateQuery, eq as storageEq, field } from "@party-stack/ontology-storage";
import { IR, compileSingleRowExpression, queryOnce, eq, gte } from "@tanstack/db";
import { Deferred, Effect, PubSub, Stream } from "effect";
import { Temporal } from "temporal-polyfill";
import { expect, test } from "vite-plus/test";
import { makeReplicatedCollection, persistedCollectionOptions, scopedCollection } from "./collections.js";
import { storageSubset } from "./subset.js";
import type { ReplicaService } from "@party-stack/ontology-replica";

const ir: ReplicaService["ir"] = {
    types: [{ name: "Rank", type: { kind: "integer", value: {} } }],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Note",
            displayName: "Note",
            pluralDisplayName: "Notes",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "Id", type: { kind: "string", value: {} } },
                {
                    name: "title",
                    displayName: "Title",
                    type: { kind: "optional", value: { type: { kind: "string", value: {} } } },
                },
                {
                    name: "rank",
                    displayName: "Rank",
                    type: { kind: "optional", value: { type: { kind: "ref", value: { name: "Rank" } } } },
                },
                {
                    name: "nested",
                    displayName: "Nested",
                    type: {
                        kind: "optional",
                        value: {
                            type: {
                                kind: "struct",
                                value: {
                                    fields: [
                                        {
                                            name: "value",
                                            displayName: "Value",
                                            type: { kind: "integer", value: {} },
                                        },
                                    ],
                                },
                            },
                        },
                    },
                },
                { name: "created", displayName: "Created", type: { kind: "timestamp", value: {} } },
                {
                    name: "tags",
                    displayName: "Tags",
                    type: {
                        kind: "optional",
                        value: {
                            type: { kind: "list", value: { elementType: { kind: "string", value: {} } } },
                        },
                    },
                },
            ],
        },
    ],
};
const ref = (name: string) => new IR.PropRef([name]);
const val = (value: unknown) => new IR.Value(value);
const fn = (name: string, ...args: IR.BasicExpression[]) => new IR.Func<boolean>(name, args);
const values = [
    { id: "a", title: "Alpha", rank: 3, nested: { value: 1 } },
    { id: "b", title: "alpha", rank: 1 },
    { id: "c", title: "Beta", rank: 2, nested: { value: 2 } },
    // Canonical ontology reads normalize provider nulls to undefined.
    { id: "d", title: undefined, rank: undefined },
    { id: "e" },
];
const rows = values.map((value) => ({ key: value.id, value }));

test("reverse IN pushes scalar-array membership through OR and preserves three-valued negation", () => {
    const data = [
        { id: "a", title: "unrelated", tags: ["urgent"] },
        { id: "b", title: "Urgent title", tags: [] },
        { id: "c", title: undefined },
        { id: "d", title: "other", tags: ["other"] },
    ];
    const membership = fn("in", val("urgent"), ref("tags"));
    const search = fn("or", fn("ilike", ref("title"), val("urgent%")), membership);
    for (const expression of [
        membership,
        search,
        fn("not", membership),
        fn("in", ref("title"), ref("tags")),
        fn("not", fn("in", ref("title"), ref("tags"))),
        fn("not", fn("in", val(undefined), ref("tags"))),
    ]) {
        const subset = storageSubset({ where: expression, limit: 2 }, ir, "Note");
        expect(subset.limit).toBe(2);
        expect(
            evaluateQuery(
                data.map((value) => ({ key: value.id, value })),
                subset
            ).map((row) => row.key)
        ).toEqual(
            data
                .filter((value) => compileSingleRowExpression(expression)(value) === true)
                .slice(0, 2)
                .map((value) => value.id)
        );
    }
    expect(storageSubset({ where: membership }, ir, "Note").where).toEqual({
        op: "contains",
        left: field("tags"),
        right: "urgent",
    });
});

test("pushdown preserves TanStack three-valued comparisons through NOT, AND, OR and IN", () => {
    const expressions = [
        fn("eq", ref("title"), val("Alpha")),
        fn("eq", val("Alpha"), ref("title")),
        fn("eq", ref("rank"), val(null)),
        fn("eq", ref("rank"), val(undefined)),
        fn("gt", ref("rank"), val(1)),
        fn("lte", ref("rank"), val(2)),
        fn("in", ref("rank"), val([1, 3, null, undefined])),
        fn("in", ref("title"), val([])),
        fn("like", ref("title"), val("A_ph%")),
        fn("ilike", ref("title"), val("a%")),
        fn("isNull", ref("title")),
        fn("isUndefined", ref("title")),
        fn("eq", new IR.PropRef(["nested", "value"]), val(1)),
    ];
    for (const expression of expressions) {
        for (const where of [
            expression,
            fn("not", expression),
            fn("or", expression, fn("eq", ref("id"), val("e"))),
            fn("not", fn("and", expression, fn("eq", ref("title"), val("alpha")))),
        ]) {
            const expected = values
                .filter((value) => compileSingleRowExpression(where)(value) === true)
                .map((value) => value.id);
            expect(evaluateQuery(rows, storageSubset({ where }, ir, "Note")).map((row) => row.key)).toEqual(
                expected
            );
        }
    }
});

test("optional ontology fields need only an undefined guard", () => {
    expect(storageSubset({ where: fn("like", ref("title"), val("A%")) }, ir, "Note").where).toEqual({
        op: "and",
        predicates: [
            { op: "ne", left: field("title"), right: undefined },
            { op: "like", left: field("title"), right: "A%" },
        ],
    });
});

test("positive equality needs no missing-value guard, but NOT and optional field equality preserve UNKNOWN", () => {
    const equal = fn("eq", ref("title"), val("Alpha"));
    expect(storageSubset({ where: equal }, ir, "Note").where).toEqual(storageEq(field("title"), "Alpha"));
    expect(storageSubset({ where: fn("eq", val("Alpha"), ref("title")) }, ir, "Note").where).toEqual(
        storageEq("Alpha", field("title"))
    );
    for (const where of [equal, fn("not", equal), fn("eq", ref("title"), ref("title"))]) {
        const query = storageSubset({ where }, ir, "Note");
        expect(evaluateQuery(rows, query).map((row) => row.key)).toEqual(
            values
                .filter((value) => compileSingleRowExpression(where)(value) === true)
                .map((value) => value.id)
        );
    }
    expect(
        evaluateQuery(rows, storageSubset({ where: fn("not", equal) }, ir, "Note")).map((row) => row.key)
    ).toEqual(["b", "c"]);
});

test("title OR array-field membership widens demand rather than excluding label-only matches", () => {
    const where = fn("or", fn("ilike", ref("title"), val("Al%")), fn("in", val("Al"), ref("labels")));
    const data = [...values, { id: "label-only", title: "Different", labels: ["Al"] }];
    const query = storageSubset({ where, limit: 1 }, ir, "Note");
    expect(query.where).toBeUndefined();
    expect(query.limit).toBeUndefined();
    const candidates = evaluateQuery(
        data.map((value) => ({ key: value.id, value })),
        query
    );
    const local = candidates.filter((row) => compileSingleRowExpression(where)(row.value) === true);
    expect(local.map((row) => row.key)).toEqual(["a", "b", "label-only"]);
});

test("field qualification is explicit and literal strings never become references", () => {
    const query = storageSubset(
        { where: fn("eq", new IR.PropRef(["note", "id"], "note"), val("id")) },
        ir,
        "Note"
    );
    expect(query.where).toEqual(storageEq(field("id"), "id"));
    expect(
        storageSubset({ where: fn("eq", new IR.PropRef(["nested", "value"]), val(1)) }, ir, "Note").where
    ).toBeDefined();
});

test("residual filters and unsupported collations widen demand before limiting", () => {
    const supported = fn("eq", ref("id"), val("a"));
    const residual = fn("eq", new IR.Func("lower", [ref("title")]), val("alpha"));
    expect(storageSubset({ where: fn("and", supported, residual), limit: 1 }, ir, "Note")).toEqual({
        where: storageEq(field("id"), "a"),
    });
    expect(
        storageSubset({ where: fn("or", supported, residual), limit: 1 }, ir, "Note").where
    ).toBeUndefined();
    expect(storageSubset({ where: fn("not", residual), limit: 1 }, ir, "Note").limit).toBeUndefined();
    for (const stringSort of [undefined, "locale"] as const) {
        const query = storageSubset(
            {
                orderBy: [
                    {
                        expression: ref("title"),
                        compareOptions: { direction: "asc", nulls: "first", stringSort },
                    },
                ],
                limit: 1,
            },
            ir,
            "Note"
        );
        expect(query.limit).toBeUndefined();
        expect(query.orderBy).toBeUndefined();
    }
    expect(
        storageSubset(
            {
                orderBy: [
                    {
                        expression: ref("title"),
                        compareOptions: {
                            direction: "asc",
                            nulls: "first",
                            stringSort: "custom",
                            compare: (a, b) => b.localeCompare(a),
                        },
                    },
                ],
                limit: 1,
            },
            ir,
            "Note"
        ).limit
    ).toBeUndefined();
    const lexical = storageSubset(
        {
            orderBy: [
                {
                    expression: ref("title"),
                    compareOptions: { direction: "asc", nulls: "last", stringSort: "lexical" },
                },
            ],
            limit: 1,
        },
        ir,
        "Note"
    );
    expect(lexical.limit).toBe(1);
    expect(lexical.orderBy?.[0]?.nulls).toBe("last");
});

test("numeric ordering pushes a prefix window and cursors retain the entire boundary tie", () => {
    const orderBy = [
        { expression: ref("rank"), compareOptions: { direction: "desc", nulls: "last" } },
    ] as const;
    const query = storageSubset({ orderBy: [...orderBy], limit: 1, offset: 1 }, ir, "Note");
    expect(query.limit).toBe(2);
    expect(query.offset).toBeUndefined();
    expect(evaluateQuery(rows, query).map((row) => row.key)).toEqual(["a", "c"]);
    const cursor = storageSubset(
        {
            orderBy: [...orderBy],
            limit: 1,
            cursor: {
                whereFrom: fn("lt", ref("rank"), val(2)),
                whereCurrent: fn("eq", ref("rank"), val(2)),
                lastKey: "c",
            },
        },
        ir,
        "Note"
    );
    expect(cursor.limit).toBeUndefined();
    expect(cursor.after).toBeUndefined();
    expect(evaluateQuery(rows, cursor).map((row) => row.key)).toEqual(["c", "b"]);
});

test("Temporal values retain typed equality and ordering", () => {
    const instant = Temporal.Instant.from("2026-10-19T00:00:00Z");
    const query = storageSubset(
        {
            where: fn("gte", ref("created"), val(instant)),
            orderBy: [{ expression: ref("created"), compareOptions: { direction: "asc", nulls: "first" } }],
            limit: 1,
        },
        ir,
        "Note"
    );
    const timed = [instant.add({ seconds: 1 }), instant.subtract({ seconds: 1 }), instant].map(
        (created, i) => ({ key: String(i), value: { created } })
    );
    expect(evaluateQuery(timed, query).map((row) => row.key)).toEqual(["2"]);
});

test("a real TanStack query forwards its predicate and numeric window into Replica demand", async () => {
    const requested: import("@party-stack/ontology-storage").Query[] = [];
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const replica = {
                    ir,
                    syncOnce: Effect.void,
                    subscribeChanges: Effect.succeed(Stream.never),
                    demand: (subset: { query: import("@party-stack/ontology-storage").Query }) =>
                        Effect.sync(() => {
                            requested.push(subset.query);
                        }),
                    loadSubset: (_type: string, query: import("@party-stack/ontology-storage").Query) =>
                        Effect.sync(() => evaluateQuery(rows, query)),
                } as unknown as ReplicaService;
                const collection = yield* makeReplicatedCollection<{ id: string; rank: number }>({
                    id: "numeric-window",
                    replica,
                    objectType: "Note",
                    getKey: (row) => row.id,
                });
                const result = yield* Effect.promise(() =>
                    queryOnce((q) =>
                        q
                            .from({ note: collection })
                            .where(({ note }) => gte(note.rank, 2))
                            .orderBy(({ note }) => note.rank, "desc")
                            .limit(1)
                    )
                );
                expect(result.map((row) => row.id)).toEqual(["a"]);
                expect(
                    requested.some(
                        (query) =>
                            query.where && query.limit === 1 && query.orderBy?.[0]?.field.path[0] === "rank"
                    )
                ).toBe(true);
                const point = yield* Effect.promise(() =>
                    queryOnce((q) => q.from({ note: collection }).where(({ note }) => eq(note.id, "b")))
                );
                expect(point.map((row) => row.id)).toEqual(["b"]);
                expect(
                    requested.some(
                        (query) => JSON.stringify(query.where) === JSON.stringify(storageEq(field("id"), "b"))
                    )
                ).toBe(true);
            })
        )
    );
});

test("overlapping scoped subsets share materialized rows and unload without clobbering another query", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const events = yield* PubSub.unbounded<void>();
                let releases = 0;
                let local: readonly { key: string; value: Record<string, unknown> }[] = rows;
                const replica = {
                    ir,
                    syncOnce: Effect.void,
                    subscribeChanges: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
                    demand: () =>
                        Effect.acquireRelease(Effect.void, () =>
                            Effect.sync(() => {
                                releases++;
                            })
                        ),
                    loadSubset: (_type: string, query: import("@party-stack/ontology-storage").Query) =>
                        Effect.sync(() => evaluateQuery(local, query)),
                } as unknown as ReplicaService;
                const collection = yield* makeReplicatedCollection<{ id: string; rank: number }>({
                    id: "overlap",
                    replica,
                    objectType: "Note",
                    getKey: (row) => row.id,
                });
                const first = { where: fn("eq", ref("id"), val("a")) };
                const controller = new AbortController();
                const second = { where: fn("gte", ref("rank"), val(2)), signal: controller.signal };
                const duplicate = { ...second, signal: undefined };
                yield* Effect.promise(async () => {
                    await collection._sync.loadSubset(first);
                    await collection._sync.loadSubset(second);
                    await collection._sync.loadSubset(duplicate);
                });
                expect([...collection.keys()]).toEqual(["a", "c"]);
                collection._sync.unloadSubset(first);
                yield* Effect.sleep(1);
                expect([...collection.keys()]).toEqual(["a", "c"]);
                expect(releases).toBe(1);
                local = local.map((row) =>
                    row.key === "a" ? { ...row, value: { ...row.value, rank: 0 } } : row
                );
                yield* PubSub.publish(events, undefined);
                yield* Effect.sleep(5);
                expect([...collection.keys()]).toEqual(["c"]);
                controller.abort();
                yield* Effect.sleep(1);
                expect(releases).toBe(2);
                local = rows;
                yield* PubSub.publish(events, undefined);
                yield* Effect.sleep(5);
                expect([...collection.keys()]).toEqual(["a", "c"]);
                collection._sync.unloadSubset(duplicate);
                yield* Effect.sleep(1);
                expect(releases).toBe(3);
            })
        )
    );
});

test("an unloaded in-flight subset cannot install rows or retain its lease", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const entered = yield* Deferred.make<void>();
                const finish = yield* Deferred.make<void>();
                let released = 0;
                const collection = yield* scopedCollection(
                    yield* persistedCollectionOptions({
                        id: "cancel-subset",
                        getKey: (row: { id: string }) => row.id,
                        changes: Stream.never,
                        acquireDemand: Effect.acquireRelease(Effect.void, () =>
                            Effect.sync(() => {
                                released++;
                            })
                        ),
                        load: () =>
                            Effect.gen(function* () {
                                yield* Deferred.succeed(entered, undefined);
                                yield* Deferred.await(finish);
                                return [{ key: "late", value: { id: "late" } }];
                            }),
                    })
                );
                const subset = { where: fn("eq", ref("id"), val("late")) };
                const loading = collection._sync.loadSubset(subset);
                yield* Deferred.await(entered);
                collection._sync.unloadSubset(subset);
                yield* Deferred.succeed(finish, undefined);
                yield* Effect.promise(async () => {
                    await loading;
                });
                expect(collection.size).toBe(0);
                expect(released).toBe(1);
            })
        )
    );
});
