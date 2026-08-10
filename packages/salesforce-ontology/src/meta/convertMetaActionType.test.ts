import { describe, expect, it } from "vitest";
import { convertSalesforceMetaActionType } from "./convertMetaActionType.js";

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
            name: "Create_Account",
            displayName: "Create Account",
            description: "Creates an account",
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
});
