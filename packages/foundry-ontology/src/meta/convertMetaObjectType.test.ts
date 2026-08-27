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
    it("maps runtime identifiers and the title property", () => {
        const result = convertFoundryMetaObjectType({
            objectType: objectType(),
            linkTypes: [],
            implementsInterfaces: [],
            implementsInterfaces2: {},
            sharedPropertyTypeMapping: {},
        } as ObjectTypeFullMetadata);

        expect(result).toMatchObject({
            id: "ri.ontology.main.object-type.employee",
            name: "Employee",
            primaryKey: "id",
            title: "fullName",
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

    it("preserves the underlying type of Foundry-formatted identifiers", () => {
        const metadata = {
            objectType: objectType(),
            linkTypes: [],
            implementsInterfaces: [],
            implementsInterfaces2: {},
            sharedPropertyTypeMapping: {},
        } as ObjectTypeFullMetadata;
        (
            metadata.objectType.properties.id as unknown as Record<
                string,
                unknown
            >
        ).valueFormatting = {
            type: "knownType",
            knownType: "USER_OR_GROUP_ID",
        };

        const result =
            convertFoundryMetaObjectType(
                metadata
            );

        expect(result.properties[0]?.type).toEqual({
            kind: "string",
            value: {},
        });
    });
});
