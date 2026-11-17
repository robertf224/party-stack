import { o } from "@party-stack/ontology-spec";
import { Effect } from "effect";
import { expect, test } from "vitest";
import * as Memory from "../memory/tables.js";
import {
    Table,
    and,
    contains,
    eq,
    field,
    gt,
    gte,
    isNull,
    isUndefined,
    length,
    lt,
    lte,
    ne,
    not,
    or,
} from "../model.js";
import { selectPlan } from "../planner/plan.js";
import { applyQuery } from "./evaluate.js";
import { indexesForQuery } from "./indexes.js";
import type { StoredIndex } from "../driver/index.js";
import type { Filter } from "../model.js";
import type { ObjectTypeDef, OntologyIR } from "@party-stack/ontology-spec";

const property = (name: string, type: ObjectTypeDef["properties"][number]["type"]) => ({
    name,
    displayName: name,
    type: o.optional({ type }),
});
const object: ObjectTypeDef = {
    name: "Row",
    displayName: "Row",
    pluralDisplayName: "Rows",
    primaryKey: "id",
    properties: [
        { name: "id", displayName: "id", type: o.string({}) },
        property("rank", o.integer({})),
        property("title", o.string({})),
        property("tags", o.list({ elementType: o.string({}) })),
        property("meta", o.struct({ fields: [{ name: "a", displayName: "a", type: o.integer({}) }] })),
    ],
};
const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: [object],
};
interface Value {
    readonly rank?: number;
    readonly tags?: readonly string[];
}
const rows: { key: string; value: Value }[] = [
    { key: "missing", value: { rank: 1 } },
    { key: "empty", value: { rank: 2, tags: [] } },
    { key: "tagged", value: { tags: ["a"] } },
    { key: "two", value: { rank: 3, tags: ["a", "a"] } },
];
const names = (where: Filter) => indexesForQuery({ where }, ir, object).map((index) => index.name);
const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect as Effect.Effect<A>);
/** Ensure every lazy index for the filter over list rows, then query through the planner. */
const query = (where: Filter) =>
    run(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const table = Table.make<Value>({ name: "rows" });
            yield* tables.putMany(table, rows);
            for (const index of indexesForQuery({ where }, ir, object))
                yield* tables.ensureIndex(table, index);
            return (yield* tables.query(table, { where })).map((row) => String(row.key)).sort();
        })
    );

test("lazy indexes fit the property type: no scalar index for a list or struct", () => {
    const size = ['query:size:["tags"]'];
    for (const where of [
        isUndefined(field("tags")),
        isNull(field("tags")),
        ne(field("tags"), undefined),
        not(eq(field("tags"), undefined)),
        gt(length(field("tags")), 0),
        eq(0, length(field("tags"))),
    ])
        expect(names(where)).toEqual(size);
    // A scalar's missing value is an ordinary key of its scalar index.
    for (const where of [isUndefined(field("rank")), eq(undefined, field("rank")), eq(field("rank"), 1)])
        expect(names(where)).toEqual(['query:scalar:["rank"]']);
    expect(names(contains(field("tags"), "a"))).toEqual(['query:elements:["tags"]']);
    // String lengths are evaluated on rows; a struct has neither a scalar nor a size index.
    expect(names(eq(length(field("title")), 0))).toEqual([]);
    expect(names(isUndefined(field("meta")))).toEqual([]);
    expect(indexesForQuery({ orderBy: [{ field: field("tags") }] }, ir, object)).toEqual([]);
});

test("missing-value checks on a list build their lazy indexes over list rows and answer exactly", async () => {
    // A replica ensures every lazy index before demanding a subset. Before size indexes,
    // a scalar index over the list failed with "Index values must be queryable scalars".
    expect(await query(isUndefined(field("tags")))).toEqual(["missing"]);
    expect(await query(ne(field("tags"), undefined))).toEqual(["empty", "tagged", "two"]);
    expect(await query(or(isUndefined(field("tags")), eq(field("rank"), 2)))).toEqual(["empty", "missing"]);
});

test("a list's size index answers missing-value and length checks without a scan", async () => {
    const tags = field("tags");
    const filters: Filter[] = [
        isUndefined(tags),
        isNull(tags),
        ne(tags, undefined),
        not(isUndefined(tags)),
        and(ne(tags, undefined), eq(length(tags), 0)),
    ];
    for (const build of [eq, ne, lt, lte, gt, gte])
        for (const bound of [-1, 0, 0.5, 1, 2, 3]) {
            filters.push(
                build(length(tags), bound),
                build(bound, length(tags)),
                not(build(length(tags), bound))
            );
        }
    for (const where of filters) {
        expect(await query(where)).toEqual(
            applyQuery(rows, { where })
                .map((row) => row.key)
                .sort()
        );
        // The planner reads only the size index.
        const indexes = indexesForQuery({ where }, ir, object).map((index): StoredIndex => ({
            ...index,
            table: "rows",
            version: 1,
        }));
        const plan = selectPlan(indexes, where);
        const lookups = (current: typeof plan): string[] =>
            current?.kind === "lookup"
                ? [current.index]
                : current?.kind === "and" || current?.kind === "or"
                  ? current.children.flatMap(lookups)
                  : current?.kind === "none"
                    ? ["none"]
                    : [];
        expect(lookups(plan).length).toBeGreaterThan(0);
        expect(lookups(plan).every((index) => index === 'query:size:["tags"]' || index === "none")).toBe(
            true
        );
    }
});
