import { expect, test } from "vitest";
import {
    and,
    contains,
    eq,
    field,
    fieldExpression,
    gt,
    inArray,
    length,
    lt,
    ne,
    not,
    or,
    type Filter,
} from "../model.js";
import { applyQuery, validateQuery } from "./evaluate.js";
import {
    fieldValues,
    filterOperand,
    lengthComparison,
    lengthEmptiness,
    mapFilterFields,
    rebindFilter,
} from "./filter.js";
import { indexesForQuery } from "./indexes.js";

const rows: { key: string; value: { tags?: string[]; title?: string } }[] = [
    { key: "missing", value: {} },
    { key: "empty", value: { tags: [], title: "" } },
    { key: "one", value: { tags: ["a"], title: "a" } },
    { key: "two", value: { tags: ["a", "a"], title: "ab" } },
];
const keys = (where: Filter) => applyQuery(rows, { where }).map((row) => row.key);

test("length counts list elements and string code units, and a missing value has length 0", () => {
    expect(keys(eq(length(field("tags")), 0))).toEqual(["empty", "missing"]);
    expect(keys(gt(length(field("tags")), 0))).toEqual(["one", "two"]);
    expect(keys(eq(length(field("tags")), 2))).toEqual(["two"]);
    expect(keys(lt(1, length(field("title"))))).toEqual(["two"]);
    expect(keys(inArray(length(field("tags")), [0, 2]))).toEqual(["empty", "missing", "two"]);
    // A missing list is still distinguishable from an empty one.
    expect(keys(and(ne(field("tags"), undefined), eq(length(field("tags")), 0)))).toEqual(["empty"]);
    expect(keys(not(eq(length(field("tags")), 0)))).toEqual(["one", "two"]);
    expect(keys(and())).toHaveLength(4);
    expect(keys(or())).toEqual([]);
});

test("the storage subset admits only row fields, literals and field lengths", () => {
    validateQuery({ where: eq(length(field("tags")), 0) });
    validateQuery({ where: contains(field("tags"), "a") });
    const other = (path: string[]) => ({
        kind: "getAt",
        value: { source: { kind: "localReference", value: { name: "other" } }, path },
    });
    for (const where of [
        { kind: "eq", value: { left: other(["tags"]), right: { kind: "literal", value: { value: 1 } } } },
        {
            kind: "eq",
            value: {
                left: { kind: "length", value: { expression: { kind: "literal", value: { value: [] } } } },
                right: { kind: "literal", value: { value: 0 } },
            },
        },
        {
            kind: "add",
            value: { left: fieldExpression(field("n")), right: { kind: "literal", value: { value: 1 } } },
        },
        eq(field("tags"), ["a"] as never),
        contains(length(field("tags")) as never, 1),
    ])
        expect(() => validateQuery({ where } as never)).toThrow();
});

test("operand views, length bounds and field values read the shared expression nodes", () => {
    expect(filterOperand(length(field("tags")))).toEqual({ kind: "length", field: field("tags") });
    expect(filterOperand(fieldExpression(field("a", "b")))).toEqual({
        kind: "field",
        field: field("a", "b"),
    });
    expect(lengthComparison(gt(1, length(field("tags"))))).toEqual({
        op: "lt",
        field: field("tags"),
        bound: 1,
    });
    expect(lengthComparison(eq(field("tags"), 0))).toBeUndefined();
    expect([0, 0.5, 1, 2].map((n) => lengthEmptiness("lt", n))).toEqual([undefined, true, true, undefined]);
    expect([-1, 0, 0.5, 1].map((n) => lengthEmptiness("gt", n))).toEqual([
        undefined,
        false,
        false,
        undefined,
    ]);
    expect(lengthEmptiness("eq", 0)).toBe(true);
    expect(lengthEmptiness("ne", 0)).toBe(false);
    expect(lengthEmptiness("eq", 1)).toBeUndefined();
    expect(fieldValues(inArray(field("id"), ["a", "b"]), ["id"])).toEqual(["a", "b"]);
    expect(fieldValues(eq("a", field("id")), ["id"])).toEqual(["a"]);
    expect(fieldValues(eq(field("other"), "a"), ["id"])).toBeUndefined();
});

test("filters move between bindings and lenses without changing their operators", () => {
    const filter = and(eq(field("a"), 1), gt(length(field("tags")), 0));
    const rebound = rebindFilter(filter, "o");
    expect(JSON.stringify(rebound)).not.toContain('"row"');
    expect(JSON.stringify(rebound).match(/"o"/g)).toHaveLength(2);
    expect(rebindFilter(filter, "row")).toBe(filter);
    expect(mapFilterFields(filter, (path) => ["source", ...path])).toEqual(
        and(eq(field("source", "a"), 1), gt(length(field("source", "tags")), 0))
    );
});

test("lazy indexes skip presence checks and lengths, which no scalar index can answer", () => {
    const properties = new Set(["tags", "title", "rank"]);
    expect(
        indexesForQuery(
            {
                where: and(
                    eq(field("tags"), undefined),
                    ne(null, field("title")),
                    gt(length(field("tags")), 0),
                    eq(field("rank"), 1)
                ),
            },
            properties
        ).map((index) => index.name)
    ).toEqual(['query:scalar:["rank"]']);
    expect(indexesForQuery({ where: contains(field("tags"), "a") }, properties)).toEqual([
        { name: 'query:elements:["tags"]', field: field("tags"), multiEntry: true },
    ]);
});
