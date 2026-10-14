import {
    compileSingleRowExpression,
    eq,
    gt,
    ilike,
    inArray,
    IR,
    isUndefined,
    like,
    lt,
    not,
} from "@tanstack/db";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vite-plus/test";
import { convertLoadSubsetFilter, isAlwaysFalseFilter } from "./convertLoadSubsetOptions.js";
import type { SearchJsonQueryV2 } from "@osdk/foundry.ontologies";

function evaluateFoundryTextPushdown(filter: SearchJsonQueryV2, row: Record<string, string>): boolean {
    if (filter.type === "and") {
        return filter.value.every((child) => evaluateFoundryTextPushdown(child, row));
    }
    if (filter.type === "or") {
        return filter.value.some((child) => evaluateFoundryTextPushdown(child, row));
    }
    if (filter.type === "not") {
        return !evaluateFoundryTextPushdown(filter.value, row);
    }

    const propertyIdentifier = filter.propertyIdentifier;
    if (propertyIdentifier?.type !== "property") {
        throw new Error(`Unsupported test property identifier for ${filter.type}`);
    }
    const value = row[propertyIdentifier.apiName]?.toLowerCase() ?? "";

    if (filter.type === "containsAllTermsInOrder") {
        return value.includes(filter.value.toLowerCase());
    }
    if (filter.type === "wildcard") {
        let regex = "";
        for (let index = 0; index < filter.value.length; index++) {
            const character = filter.value[index]!;
            if (character === "\\" && index + 1 < filter.value.length) {
                regex += filter.value[++index]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            } else if (character === "*") {
                regex += ".*";
            } else if (character === "?") {
                regex += ".";
            } else {
                regex += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            }
        }
        return new RegExp(`^${regex}$`, "s").test(value);
    }

    throw new Error(`Unsupported Foundry test filter: ${filter.type}`);
}

describe("convertLoadSubsetFilter", () => {
    it("treats null equality as an empty result", () => {
        const filter = convertLoadSubsetFilter(eq(new IR.PropRef<Date | null>(["completedAt"]), null));

        expect(isAlwaysFalseFilter(filter)).toBe(true);
    });

    it("converts undefined equality to a Foundry isNull filter", () => {
        const filter = convertLoadSubsetFilter(
            eq(new IR.PropRef<Date | undefined>(["completedAt"]), undefined)
        );

        expect(filter).toEqual({
            type: "isNull",
            propertyIdentifier: { type: "property", apiName: "completedAt" },
            value: true,
        });
    });

    it("converts isUndefined to a Foundry isNull filter", () => {
        const filter = convertLoadSubsetFilter(
            isUndefined(new IR.PropRef<Date | undefined>(["completedAt"]))
        );

        expect(filter).toEqual({
            type: "isNull",
            propertyIdentifier: { type: "property", apiName: "completedAt" },
            value: true,
        });
    });

    it("treats null range comparisons as an empty result", () => {
        const filter = convertLoadSubsetFilter(lt(new IR.PropRef<Date | null>(["completedAt"]), null));

        expect(isAlwaysFalseFilter(filter)).toBe(true);
    });

    it("serializes Temporal cursor values for Foundry", () => {
        const cursor = Temporal.Instant.from("2026-07-27T12:00:00Z");
        const expression = gt(new IR.PropRef<Temporal.Instant>(["createdAt"]), cursor);
        const filter = convertLoadSubsetFilter(expression);

        expect(filter).toMatchObject({ type: "gt", value: "2026-07-27T12:00:00Z" });
        expect(
            compileSingleRowExpression(expression)({
                createdAt: Temporal.Instant.from("2026-07-27T12:00:01Z"),
            })
        ).toBe(true);
    });

    it("converts reverse inArray expressions to Foundry contains filters", () => {
        const expression = inArray("admin", new IR.PropRef<string[]>(["roles"]));

        expect(expression).toMatchObject({
            type: "func",
            name: "in",
            args: [
                { type: "val", value: "admin" },
                { type: "ref", path: ["roles"] },
            ],
        });
        expect(convertLoadSubsetFilter(expression)).toEqual({
            type: "contains",
            propertyIdentifier: { type: "property", apiName: "roles" },
            value: "admin",
        });
        expect(compileSingleRowExpression(expression)({ roles: ["admin", "member"] })).toBe(true);
        expect(compileSingleRowExpression(expression)({ roles: ["member"] })).toBe(false);
    });

    it("preserves regular inArray pushdown", () => {
        expect(
            convertLoadSubsetFilter(inArray(new IR.PropRef<string>(["status"]), ["open", "closed"]))
        ).toEqual({
            type: "in",
            propertyIdentifier: { type: "property", apiName: "status" },
            value: ["open", "closed"],
        });
    });

    it("converts two-sided LIKE wildcards to a contains pushdown", () => {
        expect(convertLoadSubsetFilter(like(new IR.PropRef<string>(["name"]), "%foo%"))).toEqual({
            type: "containsAllTermsInOrder",
            propertyIdentifier: { type: "property", apiName: "name" },
            value: "foo",
        });
    });

    it("normalizes ILIKE contains terms for case-insensitive search", () => {
        expect(convertLoadSubsetFilter(ilike(new IR.PropRef<string>(["name"]), "%FoO%"))).toEqual({
            type: "containsAllTermsInOrder",
            propertyIdentifier: { type: "property", apiName: "name" },
            value: "foo",
        });
    });

    it("preserves supported one-sided wildcard pushdowns", () => {
        expect(convertLoadSubsetFilter(like(new IR.PropRef<string>(["name"]), "foo%"))).toMatchObject({
            type: "wildcard",
            value: "foo*",
        });
        expect(convertLoadSubsetFilter(like(new IR.PropRef<string>(["name"]), "%foo"))).toMatchObject({
            type: "wildcard",
            value: "*foo",
        });
    });

    it("distinguishes escaped LIKE characters from wildcards", () => {
        expect(convertLoadSubsetFilter(like(new IR.PropRef<string>(["name"]), "%50\\%%"))).toMatchObject({
            type: "containsAllTermsInOrder",
            value: "50%",
        });
        expect(convertLoadSubsetFilter(like(new IR.PropRef<string>(["name"]), "%foo\\_%"))).toMatchObject({
            type: "containsAllTermsInOrder",
            value: "foo_",
        });
        expect(convertLoadSubsetFilter(like(new IR.PropRef<string>(["name"]), "f_o%bar_baz"))).toMatchObject({
            type: "wildcard",
            value: "f?o*bar?baz",
        });
        expect(
            convertLoadSubsetFilter(like(new IR.PropRef<string>(["name"]), "path\\\\name%"))
        ).toMatchObject({ type: "wildcard", value: "path\\\\name*" });
    });

    it("uses contains pushdowns for each wildcard-delimited term", () => {
        expect(convertLoadSubsetFilter(ilike(new IR.PropRef<string>(["name"]), "%foo%BAR%baz%"))).toEqual({
            type: "and",
            value: [
                {
                    type: "containsAllTermsInOrder",
                    propertyIdentifier: { type: "property", apiName: "name" },
                    value: "foo",
                },
                {
                    type: "containsAllTermsInOrder",
                    propertyIdentifier: { type: "property", apiName: "name" },
                    value: "bar",
                },
                {
                    type: "containsAllTermsInOrder",
                    propertyIdentifier: { type: "property", apiName: "name" },
                    value: "baz",
                },
            ],
        });
    });

    it("does not negate an approximate contains pushdown", () => {
        expect(convertLoadSubsetFilter(not(ilike(new IR.PropRef<string>(["name"]), "%foo%")))).toEqual({
            type: "and",
            value: [],
        });
    });

    it("always fetches a superset of exact TanStack LIKE matches", () => {
        const rows = [
            { name: "foo" },
            { name: "FOO" },
            { name: "prefix foo suffix" },
            { name: "foobar" },
            { name: "foo then bar" },
            { name: "bar then foo" },
            { name: "barfoo" },
            { name: "unrelated" },
        ];
        const predicates = [
            like(new IR.PropRef<string>(["name"]), "%foo%"),
            ilike(new IR.PropRef<string>(["name"]), "%FoO%"),
            like(new IR.PropRef<string>(["name"]), "foo%"),
            ilike(new IR.PropRef<string>(["name"]), "%foo"),
            like(new IR.PropRef<string>(["name"]), "%foo%bar%"),
            not(ilike(new IR.PropRef<string>(["name"]), "%foo%")),
        ];

        for (const predicate of predicates) {
            const pushdownFilter = convertLoadSubsetFilter(predicate)!;
            const exactPredicate = compileSingleRowExpression(predicate);
            const exactRows = rows.filter((row) => exactPredicate(row));
            const fetchedRows = rows.filter((row) => evaluateFoundryTextPushdown(pushdownFilter, row));

            expect(fetchedRows).toEqual(expect.arrayContaining(exactRows));
        }
    });

    it.each([ilike, like])("converts every SQL wildcard in one-sided like patterns", (operator) => {
        const filter = convertLoadSubsetFilter(operator(new IR.PropRef<string>(["title"]), "ISSUE_one%two%"));

        expect(filter).toEqual({
            type: "wildcard",
            propertyIdentifier: { type: "property", apiName: "title" },
            value: "issue?one*two*",
        });
    });

    it.each([ilike, like])("treats patterns containing only percent wildcards as unfiltered", (operator) => {
        const filter = convertLoadSubsetFilter(operator(new IR.PropRef<string>(["title"]), "%%"));

        expect(filter).toEqual({ type: "and", value: [] });
    });
});
