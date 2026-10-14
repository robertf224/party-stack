import { describe, expect, it } from "vite-plus/test";
import { convertSalesforceMetaStandardQueryFunctionType } from "./convertMetaQueryFunctionType.js";

describe("convertSalesforceMetaStandardQueryFunctionType", () => {
    it("maps inputs and outputs, including repeated parameters", () => {
        const query = convertSalesforceMetaStandardQueryFunctionType({
            name: "getAvailableMeetingTimes",
            label: "Get Available Meeting Times",
            inputs: [
                {
                    name: "attendeeEmailAddresses",
                    label: "Attendee Email Addresses",
                    type: "STRING",
                    required: true,
                    maxOccurs: 100,
                },
            ],
            outputs: [{ name: "timeSlots", label: "Time Slots", type: "STRING", maxOccurs: 1 }],
        });

        expect(query.parameters[0]?.type).toEqual({
            kind: "list",
            value: { elementType: { kind: "string", value: {} } },
        });
        expect(query.returnType).toEqual({
            kind: "struct",
            value: {
                fields: [
                    {
                        name: "timeSlots",
                        displayName: "Time Slots",
                        description: undefined,
                        type: { kind: "optional", value: { type: { kind: "string", value: {} } } },
                    },
                ],
            },
        });
    });
});
