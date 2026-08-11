import { eq, gt, ilike, IR, like, lt } from "@tanstack/db";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { convertLoadSubsetFilter, isAlwaysFalseFilter } from "./convertLoadSubsetOptions.js";

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

    it.each([ilike, like])(
        "converts every SQL wildcard in like patterns",
        (operator) => {
            const filter = convertLoadSubsetFilter(
                operator(
                    new IR.PropRef<string>(["title"]),
                    "%ISSUE_one_two%"
                )
            );

            expect(filter).toEqual({
                type: "wildcard",
                propertyIdentifier: {
                    type: "property",
                    apiName: "title",
                },
                value: "*issue?one?two*",
            });
        }
    );

    it.each([ilike, like])(
        "treats patterns containing only percent wildcards as unfiltered",
        (operator) => {
            const filter = convertLoadSubsetFilter(
                operator(
                    new IR.PropRef<string>(["title"]),
                    "%%"
                )
            );

            expect(filter).toEqual({
                type: "and",
                value: [],
            });
        }
    );
});
