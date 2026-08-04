import { describe, expect, it } from "vitest";
import { convertFoundryMetaObjectType } from "./convertMetaObjectType.js";
import type { ObjectTypeFullMetadata } from "@osdk/foundry.ontologies";

function objectType(): ObjectTypeFullMetadata {
    return {
        objectType: {
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
        },
        linkTypes: [],
        implementsInterfaces: [],
        implementsInterfaces2: {},
        sharedPropertyTypeMapping: {},
    } as unknown as ObjectTypeFullMetadata;
}

describe("convertFoundryMetaObjectType", () => {
    it("maps Foundry object-type RID to id and preserves titleProperty", () => {
        const result = convertFoundryMetaObjectType(objectType());

        expect(result).toMatchObject({
            name: "Employee",
            id: "ri.ontology.main.object-type.employee",
            primaryKey: "id",
            titleProperty: "fullName",
            displayName: "Employee",
            pluralDisplayName: "Employees",
        });
        expect(result.properties.map((property) => property.name)).toEqual(["id", "fullName"]);
    });
});
