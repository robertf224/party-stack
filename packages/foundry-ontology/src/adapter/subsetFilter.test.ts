import {
    and,
    contains,
    eq,
    field,
    gt,
    gte,
    inArray,
    isEmpty,
    ilike,
    like,
    lt,
    lte,
    ne,
    not,
    or,
} from "@party-stack/ontology-storage";
import { expect, test } from "vite-plus/test";
import { analyzeSubsetFilter, subsetFilter } from "./subsetFilter.js";

test("execution reporting follows effective boolean pushdown, not individual operator support", () => {
    const supported = eq(field("project"), "one");
    const local = eq(field("title"), field("other"));
    expect(analyzeSubsetFilter(and(supported, local)).predicates).toEqual([
        { path: [0], execution: "source" },
        { path: [1], execution: "adapter" },
    ]);
    expect(analyzeSubsetFilter(or(supported, local)).predicates).toEqual([
        { path: [0], execution: "adapter" },
        { path: [1], execution: "adapter" },
    ]);
    expect(analyzeSubsetFilter(not(supported)).predicates).toEqual([{ path: [0], execution: "source" }]);
    expect(analyzeSubsetFilter(not(and(supported, local))).predicates).toEqual([
        { path: [0, 0], execution: "adapter" },
        { path: [0, 1], execution: "adapter" },
    ]);
    expect(
        analyzeSubsetFilter(and(supported, or(local, contains(field("tags"), "urgent")))).predicates
    ).toEqual([
        { path: [0], execution: "source" },
        { path: [1, 0], execution: "adapter" },
        { path: [1, 1], execution: "adapter" },
    ]);
});

test("candidate filtering keeps supported conjuncts without narrowing unsupported disjunctions", () => {
    const project = eq(field("project"), "one");
    const title = eq(field("title"), field("other"));
    expect(subsetFilter(and(project, title))).toEqual({
        type: "and",
        value: [{ type: "eq", field: "project", value: "one" }],
    });
    expect(subsetFilter(or(project, title))).toBeUndefined();
    expect(subsetFilter(eq(field("left"), field("right")))).toBeUndefined();
    expect(subsetFilter(eq(field("parent", "id"), "one"))).toBeUndefined();
});

test("array membership and its negation are exact", () => {
    expect(subsetFilter(contains(field("tags"), "urgent"))).toEqual({
        type: "contains",
        field: "tags",
        value: "urgent",
    });
    expect(subsetFilter(not(contains(field("tags"), "urgent")))).toEqual({
        type: "not",
        value: { type: "contains", field: "tags", value: "urgent" },
    });
    expect(subsetFilter(contains(field("tags"), field("title")))).toBeUndefined();
    expect(subsetFilter(inArray(field("rank"), [1, null]))).toBeUndefined();
    expect(subsetFilter(inArray(field("id"), ["one", "two"]))).toEqual({
        type: "in",
        field: "id",
        value: ["one", "two"],
    });
});

test("ranges are exact, counting a missing value as lower than every value like storage", () => {
    const rank = (type: string) => ({ type, field: "rank", value: 5 });
    const missing = { type: "isNull", field: "rank", value: true };
    // Foundry's ranges exclude null, which storage orders first.
    expect(subsetFilter(gt(5, field("rank")))).toEqual({ type: "or", value: [rank("lt"), missing] });
    expect(subsetFilter(lte(field("rank"), 5))).toEqual({ type: "or", value: [rank("lte"), missing] });
    expect(subsetFilter(gt(field("rank"), 5))).toEqual(rank("gt"));
    expect(subsetFilter(gte(field("rank"), 5))).toEqual(rank("gte"));
    expect(subsetFilter(not(gte(field("rank"), 5)))).toEqual({ type: "not", value: rank("gte") });
    expect(analyzeSubsetFilter(lt(field("rank"), 5)).predicates).toEqual([{ path: [], execution: "source" }]);
});

test("LIKE sends the leading word as a token prefix, since Foundry wildcards match single tokens", () => {
    const title = { type: "property", apiName: "title" };
    expect(subsetFilter(ilike(field("title"), "Urgent fix%"))).toEqual({
        type: "wildcard",
        propertyIdentifier: title,
        value: "urgent*",
    });
    expect(subsetFilter(like(field("title"), "A_B%C%"))).toEqual({
        type: "wildcard",
        propertyIdentifier: title,
        value: "a*",
    });
    expect(subsetFilter(ilike(field("title"), "a*b?\\%"))).toMatchObject({ value: "a*" });
    // A leading wildcard is refused by Foundry, and a substring can start inside a token.
    for (const pattern of ["%foo%", "_oo", "[smoke]%", "!x"])
        expect(subsetFilter(ilike(field("title"), pattern))).toBeUndefined();
    // Without wildcards, LIKE is case-sensitive equality.
    expect(subsetFilter(like(field("title"), "Exact Title"))).toEqual({
        type: "eq",
        field: "title",
        value: "Exact Title",
    });
    expect(subsetFilter(ilike(field("title"), "Exact"))).toMatchObject({ value: "exact*" });
    // A token prefix is a superset, so its negation stays local.
    expect(subsetFilter(not(ilike(field("title"), "foo%")))).toBeUndefined();
    expect(analyzeSubsetFilter(ilike(field("title"), "foo%")).predicates).toEqual([
        { path: [], execution: "candidate" },
    ]);
});

test("missing-value checks use Foundry's isNull, which is also true for an empty array", () => {
    const arrays = new Map([
        ["tags", false],
        ["required", true],
    ]);
    const missingRank = { type: "isNull", field: "rank", value: true };
    expect(subsetFilter(eq(field("rank"), undefined), arrays)).toEqual(missingRank);
    for (const negated of [ne(field("rank"), undefined), not(eq(field("rank"), undefined))])
        expect(subsetFilter(negated, arrays)).toEqual({ type: "not", value: missingRank });
    expect(subsetFilter(eq(field("rank"), null), arrays)).toBeUndefined();
    expect(subsetFilter(eq(field("nested", "value"), undefined), arrays)).toBeUndefined();

    // On arrays, missing and empty are told apart only locally.
    const missingTags = { type: "isNull", field: "tags", value: true };
    expect(subsetFilter(eq(field("tags"), undefined), arrays)).toEqual(missingTags);
    expect(subsetFilter(isEmpty(field("tags")), arrays)).toEqual(missingTags);
    expect(analyzeSubsetFilter(isEmpty(field("tags")), arrays).predicates).toEqual([
        { path: [], execution: "candidate" },
    ]);
    expect(subsetFilter(not(eq(field("tags"), undefined)), arrays)).toBeUndefined();
    expect(subsetFilter(not(isEmpty(field("tags"))), arrays)).toBeUndefined();

    // Missing or empty, the lowering of `length(tags) == 0`, is exactly `isNull`.
    const none = or(eq(field("tags"), undefined), isEmpty(field("tags")));
    expect(subsetFilter(none, arrays)).toEqual(missingTags);
    expect(subsetFilter(not(none), arrays)).toEqual({ type: "not", value: missingTags });
    expect(analyzeSubsetFilter(and(not(none), eq(field("rank"), 1)), arrays).predicates).toEqual([
        { path: [0, 0, 0], execution: "source" },
        { path: [0, 0, 1], execution: "source" },
        { path: [1], execution: "source" },
    ]);
    // A required array is never missing.
    expect(subsetFilter(not(isEmpty(field("required"))), arrays)).toEqual({
        type: "not",
        value: { type: "isNull", field: "required", value: true },
    });
});

test("negations of exact filters are sent as Foundry's not, which is a plain complement like storage's", () => {
    const rank = { type: "eq", field: "rank", value: 1 } as const;
    expect(subsetFilter(not(eq(field("rank"), 1)))).toEqual({ type: "not", value: rank });
    expect(subsetFilter(ne(field("rank"), 1))).toEqual({ type: "not", value: rank });
    expect(subsetFilter(ne(1, field("rank")))).toEqual({ type: "not", value: rank });
    expect(subsetFilter(not(or(eq(field("rank"), 1), inArray(field("id"), ["a"]))))).toEqual({
        type: "not",
        value: { type: "or", value: [rank, { type: "in", field: "id", value: ["a"] }] },
    });
    expect(subsetFilter(not(not(eq(field("rank"), 1))))).toEqual({
        type: "not",
        value: { type: "not", value: rank },
    });
    expect(analyzeSubsetFilter(and(ne(field("rank"), 1), not(eq(field("id"), "a")))).predicates).toEqual([
        { path: [0], execution: "source" },
        { path: [1, 0], execution: "source" },
    ]);

    // Negating a superset would drop rows, so partial filters stay local.
    for (const approximate of [
        ilike(field("title"), "foo%"),
        and(eq(field("rank"), 1), eq(field("title"), field("other"))),
        ne(field("left"), field("right")),
        ne(field("parent", "id"), "a"),
    ]) {
        expect(subsetFilter(not(approximate))).toBeUndefined();
        expect(
            analyzeSubsetFilter(not(approximate)).predicates.every(({ execution }) => execution === "adapter")
        ).toBe(true);
    }
});
