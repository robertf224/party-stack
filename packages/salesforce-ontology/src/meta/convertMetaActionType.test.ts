import { describe, expect, it } from "vitest";
import {
    convertSalesforceMetaActionType,
    convertSalesforceMetaStandardActionType,
} from "./convertMetaActionType.js";

describe("convertSalesforceMetaActionType", () => {
    it("maps Flow inputs and keeps empty local logic", () => {
        const action = convertSalesforceMetaActionType({
            name: "Create_Account",
            label: "Create Account",
            description: "Creates an account",
            inputs: [
                {
                    name: "accountName",
                    label: "Account Name",
                    type: "String",
                    required: true,
                },
                {
                    name: "ownerId",
                    label: "Owner",
                    type: "ID",
                    required: false,
                    sobjectType: "User",
                },
            ],
        });

        expect(action).toEqual({
            id: "salesforce:flow:Create_Account",
            meta: {
                salesforce: {
                    kind: "flow",
                    apiName: "Create_Account",
                },
            },
            name: "Create_Account",
            displayName: "Create Account",
            description: "Creates an account",
            icon: undefined,
            parameters: [
                {
                    name: "accountName",
                    displayName: "Account Name",
                    description: undefined,
                    type: { kind: "string", value: {} },
                },
                {
                    name: "ownerId",
                    displayName: "Owner",
                    description: undefined,
                    type: {
                        kind: "optional",
                        value: {
                            type: {
                                kind: "objectReference",
                                value: { objectType: "User" },
                            },
                        },
                    },
                },
            ],
            logic: [],
        });
    });

    it("treats provider parameters with null types as unknown", () => {
        const action = convertSalesforceMetaActionType({
            name: "Provider_Flow",
            inputs: [
                {
                    name: "providerValue",
                    type: null,
                },
            ],
        });

        expect(action.parameters[0]?.type).toEqual({
            kind: "optional",
            value: {
                type: {
                    kind: "unknown",
                    value: {},
                },
            },
        });
    });

    it("identifies Salesforce standard actions", () => {
        const action = convertSalesforceMetaStandardActionType({
            name: "confirmSalesMeeting",
            label: "Confirm Sales Meeting",
            inputs: [],
        });

        expect(action).toMatchObject({
            id: "salesforce:standard:confirmSalesMeeting",
            meta: {
                salesforce: {
                    kind: "standard",
                    apiName: "confirmSalesMeeting",
                },
            },
            name: "confirmSalesMeeting",
            logic: [],
        });
    });

    it("maps sObject inputs to partial record structs while preserving references", () => {
        const action = convertSalesforceMetaActionType(
            {
                name: "Create_Sales_Lead_Record",
                inputs: [
                    {
                        name: "leadRecord",
                        type: "SOBJECT",
                        required: true,
                        sObjectType: "Lead",
                    },
                    {
                        name: "ownerId",
                        type: "REFERENCE",
                        required: true,
                        sobjectType: "User",
                    },
                ],
            },
            new Map([
                [
                    "Lead",
                    {
                        name: "Lead",
                        fields: [
                            {
                                name: "LastName",
                                label: "Last Name",
                                type: "string",
                                nillable: false,
                            },
                            {
                                name: "Company",
                                label: "Company",
                                type: "string",
                                nillable: false,
                            },
                        ],
                    } as never,
                ],
            ])
        );

        expect(action.parameters[0]).toEqual({
            name: "leadRecord",
            displayName: "leadRecord",
            description: undefined,
            type: {
                kind: "struct",
                value: {
                    fields: [
                        {
                            name: "LastName",
                            displayName: "Last Name",
                            description: undefined,
                            type: {
                                kind: "optional",
                                value: {
                                    type: {
                                        kind: "string",
                                        value: {},
                                    },
                                },
                            },
                        },
                        {
                            name: "Company",
                            displayName: "Company",
                            description: undefined,
                            type: {
                                kind: "optional",
                                value: {
                                    type: {
                                        kind: "string",
                                        value: {},
                                    },
                                },
                            },
                        },
                    ],
                },
            },
        });
        expect(action.parameters[1]?.type).toEqual({
            kind: "objectReference",
            value: { objectType: "User" },
        });
    });
});
