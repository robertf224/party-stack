import { compileSingleRowExpression, eq, gt, ilike, IR, like, lt, not } from "@tanstack/db";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { convertLoadSubsetFilter, isAlwaysFalseFilter } from "./convertLoadSubsetOptions.js";
import type { SearchJsonQueryV2 } from "@osdk/foundry.ontologies";

function evaluateFoundryTextPushdown(
    filter: SearchJsonQueryV2,
    row: Record<string, string>
): boolean {
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
    it("converts null equality to an isNull filter", () => {
        const filter = convertLoadSubsetFilter(eq(new IR.PropRef<Date | null>(["completedAt"]), null));

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
        const filter = convertLoadSubsetFilter(
            gt(
                new IR.PropRef<Temporal.Instant>([
                    "createdAt",
                ]),
                Temporal.Instant.from(
                    "2026-07-27T12:00:00Z"
                )
            )
        );

        expect(filter).toMatchObject({
            type: "gt",
            value: "2026-07-27T12:00:00Z",
        });
    });

    it("converts two-sided LIKE wildcards to a contains pushdown", () => {
        expect(
            convertLoadSubsetFilter(like(new IR.PropRef<string>(["name"]), "%foo%"))
        ).toEqual({
            type: "containsAllTermsInOrder",
            propertyIdentifier: { type: "property", apiName: "name" },
            value: "foo",
        });
    });

    it("normalizes ILIKE contains terms for case-insensitive search", () => {
        expect(
            convertLoadSubsetFilter(ilike(new IR.PropRef<string>(["name"]), "%FoO%"))
        ).toEqual({
            type: "containsAllTermsInOrder",
            propertyIdentifier: { type: "property", apiName: "name" },
            value: "foo",
        });
    });

    it("preserves supported one-sided wildcard pushdowns", () => {
        expect(
            convertLoadSubsetFilter(like(new IR.PropRef<string>(["name"]), "foo%"))
        ).toMatchObject({ type: "wildcard", value: "foo*" });
        expect(
            convertLoadSubsetFilter(like(new IR.PropRef<string>(["name"]), "%foo"))
        ).toMatchObject({ type: "wildcard", value: "*foo" });
    });

    it("distinguishes escaped LIKE characters from wildcards", () => {
        expect(
            convertLoadSubsetFilter(
                like(new IR.PropRef<string>(["name"]), "%50\\%%")
            )
        ).toMatchObject({
            type: "containsAllTermsInOrder",
            value: "50%",
        });
        expect(
            convertLoadSubsetFilter(
                like(new IR.PropRef<string>(["name"]), "%foo\\_%")
            )
        ).toMatchObject({
            type: "containsAllTermsInOrder",
            value: "foo_",
        });
        expect(
            convertLoadSubsetFilter(
                like(new IR.PropRef<string>(["name"]), "f_o%bar_baz")
            )
        ).toMatchObject({
            type: "wildcard",
            value: "f?o*bar?baz",
        });
        expect(
            convertLoadSubsetFilter(
                like(new IR.PropRef<string>(["name"]), "path\\\\name%")
            )
        ).toMatchObject({
            type: "wildcard",
            value: "path\\\\name*",
        });
    });

    it("uses contains pushdowns for each wildcard-delimited term", () => {
        expect(
            convertLoadSubsetFilter(
                ilike(new IR.PropRef<string>(["name"]), "%foo%BAR%baz%")
            )
        ).toEqual({
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
        expect(
            convertLoadSubsetFilter(
                not(ilike(new IR.PropRef<string>(["name"]), "%foo%"))
            )
        ).toEqual({ type: "and", value: [] });
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
            const fetchedRows = rows.filter((row) =>
                evaluateFoundryTextPushdown(pushdownFilter, row)
            );

            expect(fetchedRows).toEqual(expect.arrayContaining(exactRows));
        }
    });
});
