import { describe, expect, it } from "vitest";
import { convertFoundryMetaObjectType } from "./convertMetaObjectType.js";
import type {
    ObjectTypeFullMetadata,
    ObjectTypeV2,
} from "@osdk/foundry.ontologies";

function objectType(): ObjectTypeV2 {
    return {
        apiName: "Employee",
        displayName: "Employee",
        pluralDisplayName: "Employees",
        status: "ACTIVE",
        description: "An employee",
        primaryKey: "id",
        titleProperty: "fullName",
        properties: {
            id: {
                dataType: { type: "string" },
                rid: "ri.ontology.main.property.employee-id",
                status: { type: "active" },
                typeClasses: [],
            },
            fullName: {
                dataType: { type: "string" },
                rid: "ri.ontology.main.property.employee-name",
                displayName: "Full name",
                status: { type: "active" },
                typeClasses: [],
            },
        },
        rid: "ri.ontology.main.object-type.employee",
    } as unknown as ObjectTypeV2;
}

describe("convertFoundryMetaObjectType", () => {
    it.each([
        ["ObjectTypeV2", objectType()],
        [
            "ObjectTypeFullMetadata",
            {
                objectType: objectType(),
                linkTypes: [],
                implementsInterfaces: [],
                implementsInterfaces2: {},
                sharedPropertyTypeMapping: {},
            } as ObjectTypeFullMetadata,
        ],
    ])("maps runtime identifiers and title expression from %s", (_label, input) => {
        const result = convertFoundryMetaObjectType(input);

        expect(result).toMatchObject({
            id: "ri.ontology.main.object-type.employee",
            name: "Employee",
            primaryKey: "id",
            title: {
                kind: "valueReference",
                value: { path: ["fullName"] },
            },
        });
        expect(result.properties).toEqual([
            expect.objectContaining({
                id: "ri.ontology.main.property.employee-id",
                name: "id",
            }),
            expect.objectContaining({
                id: "ri.ontology.main.property.employee-name",
                name: "fullName",
                displayName: "Full name",
            }),
        ]);
    });
});
