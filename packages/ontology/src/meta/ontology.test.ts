import { describe, expect, it } from "vitest";
import canonicalOntology from "../ir/schema.js";
import metaOntology from "./ontology.js";

describe("meta ontology runtime fields", () => {
    it("keeps provider identifiers out of portable definitions", () => {
        const objectType = canonicalOntology.types.find(
            (type) => type.name === "ObjectTypeDef"
        );
        const property = canonicalOntology.types.find(
            (type) => type.name === "PropertyDef"
        );

        expect(objectType?.type.kind).toBe("struct");
        expect(property?.type.kind).toBe("struct");
        if (objectType?.type.kind !== "struct" || property?.type.kind !== "struct") {
            throw new Error("Expected canonical object and property definitions to be structs.");
        }

        expect(objectType.type.value.fields.map(({ name }) => name)).not.toContain("id");
        expect(objectType.type.value.fields.find(({ name }) => name === "title")?.type).toEqual({
            kind: "optional",
            value: { type: { kind: "string", value: {} } },
        });
        expect(property.type.value.fields.map(({ name }) => name)).not.toContain("id");
    });

    it("requires IDs while preserving the canonical title field in runtime metadata", () => {
        const objectType = metaOntology.objectTypes.find(
            (type) => type.name === "ObjectType"
        );
        const property = metaOntology.types.find(
            (type) => type.name === "PropertyDef"
        );

        expect(objectType?.properties.find(({ name }) => name === "id")?.type).toEqual({
            kind: "string",
            value: {},
        });
        expect(objectType?.properties.find(({ name }) => name === "title")?.type).toEqual({
            kind: "optional",
            value: {
                type: { kind: "string", value: {} },
            },
        });

        expect(property?.type.kind).toBe("struct");
        if (property?.type.kind !== "struct") {
            throw new Error("Expected runtime PropertyDef to be a struct.");
        }
        expect(property.type.value.fields.find(({ name }) => name === "id")?.type).toEqual({
            kind: "string",
            value: {},
        });
    });
});
