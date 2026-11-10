import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import * as oq from "@party-stack/ontology-spec/query";
import { evaluateQuery, eq as storageEq, field } from "@party-stack/ontology-storage";
import { IR, compileSingleRowExpression, createLiveQueryCollection, queryOnce, eq, gte } from "@tanstack/db";
import { Deferred, Effect, PubSub, Stream, Fiber } from "effect";
import { Temporal } from "temporal-polyfill";
import { expect, test, vi } from "vite-plus/test";
import { makeReplicatedCollection, persistedCollectionOptions, scopedCollection } from "./collections.js";
import { analyzeOntologySubset, storageSubset, ontologySubset } from "./subset.js";
import type { ReplicaService } from "@party-stack/ontology-replica";
import type { ObjectSubset } from "@party-stack/ontology-spec/query";

// ReplicaService values in this file are structural test doubles, not native
// owners. Keep all real infrastructure exports; their revision fence is fixed.
vi.mock("@party-stack/ontology-replica/infrastructure", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@party-stack/ontology-replica/infrastructure")>();
    const { Effect } = await import("effect");
    return { ...actual, readVisibleRevision: () => Effect.succeed(0) };
});

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
                    name: "pinned",
                    displayName: "Pinned",
                    type: { kind: "optional", value: { type: { kind: "boolean", value: {} } } },
                },
                {
                    name: "other",
                    displayName: "Other",
                    type: { kind: "optional", value: { type: { kind: "boolean", value: {} } } },
                },
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

test("boolean ordered boundaries lower to valid Query IR with exact TanStack null semantics", async () => {
    const data = [true, false, undefined].flatMap((pinned, i) =>
        [true, false, undefined].map((other, j) => ({
            key: `${i}:${j}`,
            value: { id: `${i}:${j}`, pinned, other },
        }))
    );
    for (const op of ["gt", "gte", "lt", "lte"])
        for (const right of [val(true), val(false), ref("other")]) {
            const comparison = fn(op, ref("pinned"), right);
            for (const expression of [comparison, fn("not", comparison)]) {
                const subset = ontologySubset({ where: expression }, ir, "Note");
                const compiled = await Effect.runPromise(compileObjectSubset(ir, subset));
                expect(evaluateQuery(data, compiled.query).map((row) => row.key)).toEqual(
                    data
                        .filter((row) => compileSingleRowExpression(expression)(row.value) === true)
                        .map((row) => row.key)
                );
            }
        }
});

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

test("PlainDate equality and membership broaden before LIMIT, including negation and calendar variants", async () => {
    const iso = Temporal.PlainDate.from("2026-11-09");
    const gregory = iso.withCalendar("gregory");
    const dated: ReplicaService["ir"] = {
        ...ir,
        objectTypes: [
            {
                ...ir.objectTypes[0]!,
                properties: [
                    ...ir.objectTypes[0]!.properties,
                    { name: "day", displayName: "Day", type: { kind: "date", value: {} } },
                    {
                        name: "days",
                        displayName: "Days",
                        type: { kind: "list", value: { elementType: { kind: "date", value: {} } } },
                    },
                ],
            },
        ],
    };
    const data = [
        { id: "a", day: gregory, days: [gregory] },
        { id: "b", day: gregory, days: [gregory] },
        { id: "z", day: iso, days: [iso] },
    ].map((value) => ({ key: value.id, value }));
    const orderBy = [
        {
            expression: ref("id"),
            compareOptions: { direction: "asc", nulls: "last", stringSort: "lexical" },
        },
    ] as const;
    for (const predicate of [
        fn("eq", ref("day"), val(iso)),
        fn("in", ref("day"), val([iso])),
        fn("in", val(iso), ref("days")),
    ])
        for (const where of [predicate, fn("not", predicate)]) {
            const options = { where, orderBy: [...orderBy], limit: 1 };
            const analysis = analyzeOntologySubset(options, dated, "Note");
            expect(analysis.filterExact).toBe(false);
            expect(analysis.orderedWindowExact).toBe(false);
            expect(analysis.subset.page).toBeUndefined();
            const scan = await Effect.runPromise(
                compileObjectSubset(dated, ontologySubset(options, dated, "Note"))
            );
            const accepts = compileSingleRowExpression(where);
            const physical = evaluateQuery(data, scan.query);
            const expected = data.filter((row) => accepts(row.value) === true);
            expect(physical.filter((row) => accepts(row.value) === true)).toEqual(expected);
            expect(physical.filter((row) => accepts(row.value) === true).slice(0, 1)).toEqual(
                expected.slice(0, 1)
            );
        }
    const ordered = analyzeOntologySubset(
        {
            orderBy: [
                {
                    expression: ref("day"),
                    compareOptions: { direction: "desc", nulls: "last" },
                },
                ...orderBy,
            ],
            limit: 1,
        },
        dated,
        "Note"
    );
    expect(ordered.filterExact).toBe(true);
    expect(ordered.orderedWindowExact).toBe(true);
    expect(ordered.subset.page?.limit).toBe(1);
});

test("a real TanStack query forwards its predicate and numeric window into Replica demand", async () => {
    const requested: ObjectSubset[] = [];
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const replica = {
                    ir,
                    syncOnce: Effect.void,
                    syncSubset: () => Effect.void,
                    subscribeChanges: Effect.succeed(Stream.never),
                    observeSubset: (subset: ObjectSubset) =>
                        Stream.fromEffect(
                            Effect.map(compileObjectSubset(ir, subset), (scan) => ({
                                revision: 0,
                                reset: true,
                                rows: evaluateQuery(rows, scan.query),
                                removed: [],
                            }))
                        ),
                    demand: {
                        acquire: (subset: ObjectSubset) =>
                            Effect.sync(() => {
                                requested.push(subset);
                            }),
                    },
                    readSubset: (subset: ObjectSubset) =>
                        Effect.flatMap(compileObjectSubset(ir, subset), (scan) =>
                            Effect.sync(() => evaluateQuery(rows, scan.query))
                        ),
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
                            query.where &&
                            query.page?.limit === 1 &&
                            query.orderBy?.[0]?.expression.kind === "getAt" &&
                            query.orderBy[0].expression.value.path[0] === "rank"
                    )
                ).toBe(true);
                const point = yield* Effect.promise(() =>
                    queryOnce((q) => q.from({ note: collection }).where(({ note }) => eq(note.id, "b")))
                );
                expect(point.map((row) => row.id)).toEqual(["b"]);
                expect(
                    requested.some(
                        (query) =>
                            JSON.stringify(query.where) ===
                            JSON.stringify(oq.eq(oq.field("row", "id"), oq.literal("b")))
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
                const eventsBus = yield* PubSub.unbounded<void>();
                let releases = 0;
                let local: readonly { key: string; value: Record<string, unknown> }[] = rows;
                let revision = 0;
                const replica = {
                    ir,
                    syncOnce: Effect.void,
                    syncSubset: () => Effect.void,
                    subscribeChanges: PubSub.subscribe(eventsBus).pipe(Effect.map(Stream.fromSubscription)),
                    observeSubset: (subset: ObjectSubset) =>
                        Stream.unwrap(
                            Effect.gen(function* () {
                                const scan = yield* compileObjectSubset(ir, subset);
                                const events = yield* PubSub.subscribe(eventsBus).pipe(
                                    Effect.map(Stream.fromSubscription)
                                );
                                return Stream.concat(Stream.succeed(undefined), events).pipe(
                                    Stream.map(() => ({
                                        revision,
                                        reset: true,
                                        rows: evaluateQuery(local, scan.query),
                                        removed: [],
                                    }))
                                );
                            })
                        ),
                    demand: {
                        acquire: () =>
                            Effect.acquireRelease(Effect.void, () =>
                                Effect.sync(() => {
                                    releases++;
                                })
                            ),
                    },
                    readSubset: (subset: ObjectSubset) =>
                        Effect.flatMap(compileObjectSubset(ir, subset), (scan) =>
                            Effect.sync(() => evaluateQuery(local, scan.query))
                        ),
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
                revision++;
                yield* PubSub.publish(eventsBus, undefined);
                yield* Effect.sleep(5);
                expect([...collection.keys()]).toEqual(["c"]);
                controller.abort();
                yield* Effect.sleep(1);
                expect(releases).toBe(2);
                local = rows;
                revision++;
                yield* PubSub.publish(eventsBus, undefined);
                yield* Effect.sleep(5);
                expect([...collection.keys()]).toEqual(["a", "c"]);
                collection._sync.unloadSubset(duplicate);
                yield* Effect.sleep(1);
                expect(releases).toBe(3);
            })
        )
    );
});

test("fulfilled live regions keep filtered window updates live while new acquisitions wait", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const events = yield* PubSub.unbounded<void>();
                let local: readonly { key: string; value: Record<string, unknown> }[] = rows;
                let revision = 0;
                let acquisitions = 0;
                const replica = {
                    ir,
                    readSubset: () => Effect.succeed([]),
                    demand: {
                        acquire: () =>
                            Effect.suspend(() => (++acquisitions === 1 ? Effect.void : Effect.never)),
                    },
                    observeSubset: (subset: ObjectSubset) =>
                        Stream.unwrap(
                            Effect.gen(function* () {
                                const scan = yield* compileObjectSubset(ir, subset);
                                const changes = yield* PubSub.subscribe(events).pipe(
                                    Effect.map(Stream.fromSubscription)
                                );
                                return Stream.concat(Stream.succeed(undefined), changes).pipe(
                                    Stream.map(() => ({
                                        revision,
                                        reset: true,
                                        rows: evaluateQuery(local, scan.query),
                                        removed: [],
                                    }))
                                );
                            })
                        ),
                } as unknown as ReplicaService;
                const source = yield* makeReplicatedCollection<{ id: string; rank: number }>({
                    id: "held-region-readiness",
                    replica,
                    objectType: "Note",
                    getKey: (row) => row.id,
                });
                // This source has already supplied every row in the region, including
                // future locally observed changes. No collection-wide preload is needed.
                yield* Effect.promise(() =>
                    Promise.resolve(source._sync.loadSubset({ where: fn("gte", ref("rank"), val(2)) }))
                );
                const query = createLiveQueryCollection({
                    query: (q) =>
                        q
                            .from({ row: source })
                            .where(({ row }) => gte(row.rank, 2))
                            .orderBy(({ row }) => row.id, "asc")
                            .limit(51)
                            .select(({ row }) => ({ id: row.id })),
                });
                yield* Effect.addFinalizer(() => Effect.promise(() => query.cleanup()));
                yield* Effect.promise(() => query.preload());
                expect(query.toArray.map((row) => row.id)).toEqual(["a", "c"]);
                local = local.map((row) =>
                    row.key === "a" ? { ...row, value: { ...row.value, rank: 0 } } : row
                );
                revision++;
                yield* PubSub.publish(events, undefined);
                yield* Effect.promise(() =>
                    vi.waitFor(() => expect(query.toArray.map((row) => row.id)).toEqual(["c"]))
                );
                expect(acquisitions).toBeGreaterThan(1);
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

test("collection cleanup awaits a subset release already detached from its parent scope", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const releasing = yield* Deferred.make<void>();
                const finish = yield* Deferred.make<void>();
                const collection = yield* scopedCollection(
                    yield* persistedCollectionOptions({
                        id: "await-unloaded-release",
                        getKey: (row: { id: string }) => row.id,
                        changes: Stream.never,
                        load: Effect.succeed([]),
                        acquireDemand: Effect.acquireRelease(Effect.void, () =>
                            Deferred.succeed(releasing, undefined).pipe(
                                Effect.andThen(Deferred.await(finish))
                            )
                        ),
                    })
                );
                const subset = {};
                yield* Effect.promise(async () => {
                    await collection._sync.loadSubset(subset);
                });
                collection._sync.unloadSubset(subset);
                yield* Deferred.await(releasing);
                let cleaned = false;
                const cleanup = yield* Effect.forkChild(
                    Effect.promise(async () => {
                        await collection.cleanup();
                        cleaned = true;
                    })
                );
                yield* Effect.yieldNow;
                expect(cleaned).toBe(false);
                yield* Deferred.succeed(finish, undefined);
                yield* Fiber.join(cleanup);
                expect(cleaned).toBe(true);
            })
        )
    );
});
