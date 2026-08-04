import { describe, expect, it } from "vitest";
import { convertFoundryMetaLinkTypes } from "./convertMetaLinkType.js";
import type { ObjectTypeFullMetadata } from "@osdk/foundry.ontologies";

describe("convertFoundryMetaLinkTypes", () => {
    it("preserves FK-backed links with per-side cardinality", () => {
        const objectTypes = [
            {
                objectType: { apiName: "Employee" },
                linkTypes: [
                    {
                        apiName: "department",
                        displayName: "Department",
                        status: "ACTIVE",
                        objectTypeApiName: "Department",
                        cardinality: "ONE",
                        foreignKeyPropertyApiName: "departmentId",
                        linkTypeRid: "ri.ontology.main.link-type.employee-department",
                        linkTypeId: "employee-department",
                    },
                ],
            },
            {
                objectType: { apiName: "Department" },
                linkTypes: [
                    {
                        apiName: "employees",
                        displayName: "Employees",
                        status: "ACTIVE",
                        objectTypeApiName: "Employee",
                        cardinality: "MANY",
                        linkTypeRid: "ri.ontology.main.link-type.employee-department",
                        linkTypeId: "employee-department",
                    },
                ],
            },
        ] as unknown as ObjectTypeFullMetadata[];

        expect(convertFoundryMetaLinkTypes(objectTypes)).toEqual([
            {
                id: "ri.ontology.main.link-type.employee-department",
                source: {
                    objectType: "Employee",
                    name: "employees",
                    displayName: "Employees",
                    cardinality: "many",
                },
                target: {
                    objectType: "Department",
                    name: "department",
                    displayName: "Department",
                    cardinality: "one",
                },
                foreignKey: "departmentId",
                cardinality: "many",
            },
        ]);
    });

    it("keeps non-FK bidirectional links without dropping them", () => {
        const objectTypes = [
            {
                objectType: { apiName: "Post" },
                linkTypes: [
                    {
                        apiName: "comments",
                        displayName: "Comments",
                        status: "ACTIVE",
                        objectTypeApiName: "Comment",
                        cardinality: "MANY",
                        linkTypeRid: "ri.ontology.main.link-type.post-comment",
                        linkTypeId: "post-comment",
                    },
                ],
            },
            {
                objectType: { apiName: "Comment" },
                linkTypes: [
                    {
                        apiName: "post",
                        displayName: "Post",
                        status: "ACTIVE",
                        objectTypeApiName: "Post",
                        cardinality: "ONE",
                        linkTypeRid: "ri.ontology.main.link-type.post-comment",
                        linkTypeId: "post-comment",
                    },
                ],
            },
        ] as unknown as ObjectTypeFullMetadata[];

        expect(convertFoundryMetaLinkTypes(objectTypes)).toEqual([
            {
                id: "ri.ontology.main.link-type.post-comment",
                source: {
                    objectType: "Post",
                    name: "post",
                    displayName: "Post",
                    cardinality: "one",
                },
                target: {
                    objectType: "Comment",
                    name: "comments",
                    displayName: "Comments",
                    cardinality: "many",
                },
                foreignKey: undefined,
                cardinality: "one",
            },
        ]);
    });
});
