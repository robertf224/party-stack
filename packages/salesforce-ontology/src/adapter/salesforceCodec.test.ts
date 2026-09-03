import { o } from "@party-stack/ontology";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { createSalesforceCodec } from "./salesforceCodec.js";

describe("createSalesforceCodec", () => {
    const codec = createSalesforceCodec({
        types: [],
        objectTypes: [
            {
                name: "Account",
                displayName: "Account",
                pluralDisplayName: "Accounts",
                primaryKey: "Id",
                properties: [
                    { name: "Id", displayName: "Id", type: o.string({}) },
                    { name: "Name", displayName: "Name", type: o.string({}) },
                    { name: "CreatedDate", displayName: "Created Date", type: o.timestamp({}) },
                    {
                        name: "CloseDate",
                        displayName: "Close Date",
                        type: o.optional({ type: o.date({}) }),
                    },
                    {
                        name: "Tags",
                        displayName: "Tags",
                        type: o.list({ elementType: o.string({}) }),
                    },
                ],
            },
        ],
        linkTypes: [],
        actionTypes: [],
        queryFunctionTypes: [],
    });

    it("strips Salesforce attributes and decodes temporal/multipicklist values", () => {
        expect(
            codec.decodeObject("Account", {
                attributes: { type: "Account", url: "/services/data/v61.0/sobjects/Account/001" },
                Id: "001xx",
                Name: "Acme",
                CreatedDate: "2026-08-06T12:00:00.000Z",
                CloseDate: "2026-08-07",
                Tags: "a;b",
            })
        ).toEqual({
            Id: "001xx",
            Name: "Acme",
            CreatedDate: Temporal.Instant.from("2026-08-06T12:00:00.000Z"),
            CloseDate: Temporal.PlainDate.from("2026-08-07"),
            Tags: ["a", "b"],
        });
    });

    it("encodes multipicklist and temporal values for Flow inputs", () => {
        expect(
            codec.encodeValue(o.list({ elementType: o.string({}) }), ["a", "b"])
        ).toBe("a;b");
        expect(
            codec.encodeValue(o.timestamp({}), Temporal.Instant.from("2026-08-06T12:00:00Z"))
        ).toBe("2026-08-06T12:00:00Z");
        expect(codec.encodeValue(o.date({}), Temporal.PlainDate.from("2026-08-07"))).toBe(
            "2026-08-07"
        );
    });
});
