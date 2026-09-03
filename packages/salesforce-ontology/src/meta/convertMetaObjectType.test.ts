import { describe, expect, it } from "vitest";
import type { SalesforceSObjectDescribe } from "@party-stack/salesforce-client";
import { convertSalesforceMetaLinkTypes } from "./convertMetaLinkType.js";
import { convertSalesforceMetaObjectType } from "./convertMetaObjectType.js";

const accountDescribe = {
    name: "Account",
    label: "Account",
    labelPlural: "Accounts",
    custom: false,
    createable: true,
    updateable: true,
    deletable: true,
    queryable: true,
    searchable: true,
    retrieveable: true,
    fields: [
        {
            name: "Id",
            label: "Account ID",
            type: "id",
            nillable: false,
            createable: false,
            updateable: false,
            custom: false,
            calculated: false,
            filterable: true,
            sortable: true,
            unique: false,
            externalId: false,
            idLookup: true,
            referenceTo: [],
            relationshipName: null,
        },
        {
            name: "Name",
            label: "Account Name",
            type: "string",
            nillable: false,
            createable: true,
            updateable: true,
            custom: false,
            calculated: false,
            filterable: true,
            sortable: true,
            unique: false,
            externalId: false,
            idLookup: false,
            referenceTo: [],
            relationshipName: null,
        },
        {
            name: "OwnerId",
            label: "Owner ID",
            type: "reference",
            nillable: false,
            createable: true,
            updateable: true,
            custom: false,
            calculated: false,
            filterable: true,
            sortable: true,
            unique: false,
            externalId: false,
            idLookup: false,
            referenceTo: ["User"],
            relationshipName: "Owner",
        },
        {
            name: "WhoId",
            label: "Name ID",
            type: "reference",
            nillable: true,
            createable: true,
            updateable: true,
            custom: false,
            calculated: false,
            filterable: true,
            sortable: true,
            unique: false,
            externalId: false,
            idLookup: false,
            referenceTo: ["Contact", "Lead"],
            relationshipName: "Who",
        },
        {
            name: "BillingAddress",
            label: "Billing Address",
            type: "address",
            nillable: true,
            createable: false,
            updateable: false,
            custom: false,
            calculated: false,
            filterable: false,
            sortable: false,
            unique: false,
            externalId: false,
            idLookup: false,
            referenceTo: [],
            relationshipName: null,
        },
        {
            name: "Industry",
            label: "Industry",
            type: "picklist",
            nillable: true,
            createable: true,
            updateable: true,
            custom: false,
            calculated: false,
            filterable: true,
            sortable: true,
            unique: false,
            externalId: false,
            idLookup: false,
            referenceTo: [],
            relationshipName: null,
            picklistValues: [
                { active: true, defaultValue: false, label: "Agriculture", value: "Agriculture" },
                { active: false, defaultValue: false, label: "Legacy", value: "Legacy" },
            ],
        },
    ],
    childRelationships: [],
} as unknown as SalesforceSObjectDescribe;

describe("convertSalesforceMetaObjectType", () => {
    it("maps describe fields and chooses a title property", () => {
        const objectType = convertSalesforceMetaObjectType(accountDescribe);

        expect(objectType).toMatchObject({
            id: "salesforce:sobject:Account",
            name: "Account",
            primaryKey: "Id",
            title: "Name",
        });
        expect(objectType.properties.find((property) => property.name === "BillingAddress")).toBeUndefined();
        expect(objectType.properties.find((property) => property.name === "Industry")?.type).toEqual({
            kind: "optional",
            value: {
                type: {
                    kind: "string",
                    value: {
                        constraint: {
                            kind: "enum",
                            value: {
                                options: [{ value: "Agriculture", label: "Agriculture" }],
                            },
                        },
                    },
                },
            },
        });
        expect(objectType.properties.find((property) => property.name === "OwnerId")?.type).toEqual({
            kind: "objectReference",
            value: { objectType: "User" },
        });
        expect(objectType.properties.find((property) => property.name === "WhoId")?.type).toEqual({
            kind: "optional",
            value: { type: { kind: "string", value: {} } },
        });
    });
});

describe("convertSalesforceMetaLinkTypes", () => {
    it("creates links for single-target references and skips polymorphic ones", () => {
        const links = convertSalesforceMetaLinkTypes([accountDescribe]);

        expect(links).toHaveLength(1);
        expect(links[0]).toMatchObject({
            id: "salesforce:link:Account.OwnerId",
            foreignKey: "OwnerId",
            cardinality: "many",
            target: {
                objectType: "User",
                name: "Owner",
            },
            source: {
                objectType: "Account",
            },
        });
    });
});
