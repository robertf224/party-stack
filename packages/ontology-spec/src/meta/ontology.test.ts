import { describe, expect, it } from "vitest";
import canonicalOntology from "../ir/schema.js";
import metaOntology from "./ontology.js";

describe("meta ontology runtime fields", () => {
    it("gives definitions an optional provider id and preserves presentation metadata", () => {
        const objectType = canonicalOntology.types.find((type) => type.name === "ObjectTypeDef");
        const property = canonicalOntology.types.find((type) => type.name === "PropertyDef");
        const actionType = canonicalOntology.types.find((type) => type.name === "ActionTypeDef");
        const icon = canonicalOntology.types.find((type) => type.name === "IconDescriptor");

        expect(objectType?.type.kind).toBe("struct");
        expect(property?.type.kind).toBe("struct");
        expect(actionType?.type.kind).toBe("struct");
        if (
            objectType?.type.kind !== "struct" ||
            property?.type.kind !== "struct" ||
            actionType?.type.kind !== "struct"
        ) {
            throw new Error("Expected canonical object, property, and action definitions to be structs.");
        }

        const optionalString = { kind: "optional", value: { type: { kind: "string", value: {} } } };
        expect(objectType.type.value.fields.find(({ name }) => name === "id")?.type).toEqual(optionalString);
        expect(objectType.type.value.fields.find(({ name }) => name === "title")?.type).toEqual({
            kind: "optional",
            value: { type: { kind: "string", value: {} } },
        });
        expect(property.type.value.fields.find(({ name }) => name === "id")?.type).toEqual(optionalString);
        expect(actionType.type.value.fields.find(({ name }) => name === "id")?.type).toEqual(optionalString);
        expect(objectType.type.value.fields.map(({ name }) => name)).toEqual(
            expect.arrayContaining(["icon", "color"])
        );
        expect(actionType.type.value.fields.map(({ name }) => name)).toEqual(
            expect.arrayContaining(["icon", "color"])
        );
        expect(icon?.type.kind).toBe("struct");
        if (icon?.type.kind !== "struct") {
            throw new Error("Expected IconDescriptor to be a struct.");
        }
        expect(icon.type.value.fields.find(({ name }) => name === "name")?.type).toEqual({
            kind: "ref",
            value: { name: "IconName" },
        });
        expect(icon.type.value.fields.map(({ name }) => name)).toContain("meta");
        expect(icon.type.value.fields.map(({ name }) => name)).not.toContain("metadata");
        expect(actionType.type.value.fields.find(({ name }) => name === "meta")?.type).toEqual({
            kind: "optional",
            value: {
                type: {
                    kind: "map",
                    value: {
                        keyType: {
                            kind: "string",
                            value: {},
                        },
                        valueType: {
                            kind: "unknown",
                            value: {},
                        },
                    },
                },
            },
        });
    });

    it("requires the ids a definition may leave out", () => {
        const stringType = { kind: "string", value: {} };
        for (const name of ["ObjectType", "ActionType", "LinkType", "QueryFunctionType", "ValueType"]) {
            const objectType = metaOntology.objectTypes.find((type) => type.name === name);
            expect(objectType?.properties.find((property) => property.name === "id")?.type).toEqual(
                stringType
            );
        }
        const property = metaOntology.types.find((type) => type.name === "PropertyDef");
        if (property?.type.kind !== "struct") throw new Error("Expected PropertyDef to be a struct.");
        expect(property.type.value.fields.find(({ name }) => name === "id")?.type).toEqual(stringType);
    });
});
