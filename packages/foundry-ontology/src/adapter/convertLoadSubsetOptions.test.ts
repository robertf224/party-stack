import { eq, IR, lt } from "@tanstack/db";
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
});
