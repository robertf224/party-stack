import { and, contains, eq, field, gt, inArray, ilike, not, or } from "@party-stack/ontology-storage";
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
    expect(analyzeSubsetFilter(not(supported)).predicates).toEqual([{ path: [0], execution: "adapter" }]);
    expect(
        analyzeSubsetFilter(and(supported, or(local, contains(field("tags"), "urgent")))).predicates
    ).toEqual([
        { path: [0], execution: "source" },
        { path: [1, 0], execution: "adapter" },
        { path: [1, 1], execution: "adapter" },
    ]);
});

test("candidate filtering keeps supported conjuncts without narrowing unsupported disjunctions or negations", () => {
    const project = eq(field("project"), "one");
    const title = eq(field("title"), field("other"));
    expect(subsetFilter(and(project, title))).toEqual({
        type: "and",
        value: [{ type: "eq", field: "project", value: "one" }],
    });
    expect(subsetFilter(or(project, title))).toBeUndefined();
    expect(subsetFilter(not(project))).toBeUndefined();
    expect(subsetFilter(eq(field("left"), field("right")))).toBeUndefined();
    expect(subsetFilter(eq(field("parent", "id"), "one"))).toBeUndefined();
});

test("text OR array membership reaches Foundry search and retains literal wildcard characters", () => {
    expect(subsetFilter(or(ilike(field("title"), "Urgent%"), contains(field("tags"), "urgent")))).toEqual({
        type: "or",
        value: [
            {
                type: "wildcard",
                propertyIdentifier: { type: "property", apiName: "title" },
                value: "urgent*",
            },
            { type: "contains", field: "tags", value: "urgent" },
        ],
    });
    expect(subsetFilter(ilike(field("title"), "a*b?\\%"))).toMatchObject({
        type: "wildcard",
        value: "a\\*b\\?\\\\*",
    });
    expect(subsetFilter(not(contains(field("tags"), "urgent")))).toBeUndefined();
    expect(subsetFilter(contains(field("tags"), field("title")))).toBeUndefined();
});

test("range candidates include provider-null rows to preserve the storage ordering semantics", () => {
    expect(subsetFilter(gt(5, field("rank")))).toEqual({
        type: "or",
        value: [
            { type: "lt", field: "rank", value: 5 },
            { type: "isNull", field: "rank", value: true },
        ],
    });
    expect(subsetFilter(eq(field("rank"), undefined))).toBeUndefined();
    expect(subsetFilter(inArray(field("rank"), [1, null]))).toBeUndefined();
    expect(subsetFilter(inArray(field("id"), ["one", "two"]))).toEqual({
        type: "in",
        field: "id",
        value: ["one", "two"],
    });
});
