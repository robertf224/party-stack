import { and, eq, field, inArray, like, not, or } from "@party-stack/ontology-storage";
import { describe, expect, it } from "vite-plus/test";
import { planMetaLookup } from "./planMetaLookup.js";

const fields = { name: "name", id: "id" };

describe("metadata lookup planning", () => {
    it("deduplicates exact batches and preserves empty batches", () => {
        expect(planMetaLookup(inArray(field("name"), ["A", "A", "B"]), fields)).toEqual({
            field: "name",
            values: ["A", "B"],
        });
        expect(planMetaLookup(inArray(field("name"), []), fields)).toEqual({ field: "name", values: [] });
    });

    it("handles either operand order in exact equality", () => {
        expect(planMetaLookup(eq("A", field("name")), fields)).toEqual({ field: "name", values: ["A"] });
    });

    it("keeps a bounded AND branch with a residual predicate", () => {
        expect(planMetaLookup(and(like(field("displayName"), "B%"), eq(field("name"), "A")), fields)).toEqual(
            { field: "name", values: ["A"] }
        );
    });

    it("uses an empty conjunct even when another bounded branch appears first", () => {
        expect(planMetaLookup(and(eq(field("id"), "rid"), inArray(field("name"), [])), fields)).toEqual({
            field: "name",
            values: [],
        });
    });

    it("never partially pushes down an OR", () => {
        expect(planMetaLookup(or(eq(field("name"), "A"), like(field("name"), "B%")), fields)).toBeUndefined();
        expect(planMetaLookup(or(eq(field("name"), "A"), eq(field("id"), "rid")), fields)).toBeUndefined();
    });

    it("does not narrow field comparisons, negations, or unknown fields", () => {
        expect(planMetaLookup(eq(field("name"), field("id")), fields)).toBeUndefined();
        expect(planMetaLookup(not(eq(field("name"), "A")), fields)).toBeUndefined();
        expect(planMetaLookup(eq(field("toString"), "A"), fields)).toBeUndefined();
        expect(planMetaLookup(inArray(field("name"), ["A", null]), fields)).toBeUndefined();
    });

    it("unions endpoint neighborhoods for OR and selects one for AND", () => {
        const source = eq(field("source", "objectType"), "A");
        const target = eq(field("target", "objectType"), "B");
        const endpoints = { "source.objectType": "objectType", "target.objectType": "objectType" };
        expect(planMetaLookup(or(source, target), endpoints)).toEqual({
            field: "objectType",
            values: ["A", "B"],
        });
        expect(planMetaLookup(and(source, target), endpoints)).toEqual({
            field: "objectType",
            values: ["A"],
        });
    });

    it("covers each nested OR branch even when they have different residual filters", () => {
        expect(
            planMetaLookup(
                or(
                    and(eq(field("name"), "A"), like(field("displayName"), "Alpha%")),
                    and(eq(field("name"), "B"), not(eq(field("displayName"), "Beta")))
                ),
                fields
            )
        ).toEqual({ field: "name", values: ["A", "B"] });
    });
});
