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
                type: {
                    kind: "string",
                    value: {},
                },
            }),
            expect.objectContaining({
                id: "ri.ontology.main.property.employee-name",
                name: "fullName",
                displayName: "Full name",
                type: {
                    kind: "optional",
                    value: {
                        type: {
                            kind: "string",
                            value: {},
                        },
                    },
                },
            }),
        ]);
    });

    it("treats non-primary attachment and value-type properties as optional", () => {
        const metadata = {
            objectType: objectType(),
            linkTypes: [],
            implementsInterfaces: [],
            implementsInterfaces2: {},
            sharedPropertyTypeMapping: {},
        } as ObjectTypeFullMetadata;
        metadata.objectType.properties.profileImage = {
            dataType: { type: "attachment" },
            rid: "ri.ontology.main.property.employee-profile-image",
            status: { type: "active" },
            typeClasses: [],
        };
        metadata.objectType.properties.departmentCode = {
            dataType: { type: "string" },
            rid: "ri.ontology.main.property.employee-department-code",
            status: { type: "active" },
            typeClasses: [],
            valueTypeApiName: "DepartmentCode",
        };

        const result = convertFoundryMetaObjectType(metadata);

        expect(result.properties.find((property) => property.name === "profileImage")?.type).toEqual({
            kind: "optional",
            value: {
                type: {
                    kind: "attachment",
                    value: { meta: { type: "attachment" } },
                },
            },
        });
        expect(
            result.properties.find((property) => property.name === "departmentCode")?.type
        ).toEqual({
            kind: "optional",
            value: {
                type: {
                    kind: "ref",
                    value: { name: "DepartmentCode" },
                },
            },
        });
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
