import { IR, lt } from "@tanstack/db";
import { describe, expect, it } from "vitest";
import { convertLoadSubsetFilter, isAlwaysFalseFilter } from "./convertLoadSubsetOptions.js";

describe("convertLoadSubsetFilter", () => {
    it("treats null range comparisons as an empty result", () => {
        const filter = convertLoadSubsetFilter(lt(new IR.PropRef<Date | null>(["completedAt"]), null));

        expect(isAlwaysFalseFilter(filter)).toBe(true);
    });
});
