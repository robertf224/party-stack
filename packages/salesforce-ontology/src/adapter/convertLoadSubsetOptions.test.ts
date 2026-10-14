import { eq, gt, inArray, IR, lt } from "@tanstack/db";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vite-plus/test";
import {
    buildSoqlQuery,
    convertLoadSubsetFilter,
    isAlwaysFalseFilter,
    serializeSoqlLiteral,
} from "./convertLoadSubsetOptions.js";

describe("serializeSoqlLiteral", () => {
    it("escapes strings and serializes temporal values", () => {
        expect(serializeSoqlLiteral("O'Brien")).toBe("'O\\'Brien'");
        expect(serializeSoqlLiteral(true)).toBe("true");
        expect(serializeSoqlLiteral(Temporal.PlainDate.from("2026-08-06"))).toBe("2026-08-06");
        expect(serializeSoqlLiteral(Temporal.Instant.from("2026-08-06T12:00:00Z"))).toBe(
            "2026-08-06T12:00:00Z"
        );
    });

    it("keeps injection-shaped strings inside one escaped literal", () => {
        expect(serializeSoqlLiteral("x' OR Name != ''")).toBe(String.raw`'x\' OR Name != \'\''`);
        expect(serializeSoqlLiteral(String.raw`x\' OR Name != null`)).toBe(
            String.raw`'x\\\' OR Name != null'`
        );
    });

    it("escapes supported control characters and rejects the rest", () => {
        expect(serializeSoqlLiteral("line1\nline2\tvalue")).toBe(String.raw`'line1\nline2\tvalue'`);
        expect(() => serializeSoqlLiteral("before\u0000after")).toThrow(/control character U\+0000/);
    });
});

describe("convertLoadSubsetFilter", () => {
    it("converts equality and null checks", () => {
        expect(convertLoadSubsetFilter(eq(new IR.PropRef(["Name"]), "Acme"))).toEqual({
            clause: "Name = 'Acme'",
            alwaysFalse: false,
        });
        expect(convertLoadSubsetFilter(eq(new IR.PropRef(["DeletedDate"]), null))).toEqual({
            clause: "DeletedDate = null",
            alwaysFalse: false,
        });
    });

    it("treats null range comparisons as always false", () => {
        const filter = convertLoadSubsetFilter(lt(new IR.PropRef(["Amount"]), null));
        expect(isAlwaysFalseFilter(filter)).toBe(true);
    });

    it("serializes Temporal values", () => {
        const filter = convertLoadSubsetFilter(
            gt(new IR.PropRef(["CreatedDate"]), Temporal.Instant.from("2026-07-27T12:00:00Z"))
        );
        expect(filter).toEqual({ clause: "CreatedDate > 2026-07-27T12:00:00Z", alwaysFalse: false });
    });

    it("converts reverse inArray expressions to SOQL INCLUDES", () => {
        expect(
            convertLoadSubsetFilter(inArray("Enterprise", new IR.PropRef<string[]>(["Customer_Tiers__c"])))
        ).toEqual({ clause: "Customer_Tiers__c INCLUDES ('Enterprise')", alwaysFalse: false });
    });

    it("escapes untrusted values in generated filters", () => {
        expect(
            convertLoadSubsetFilter(
                eq(new IR.PropRef<string>(["Name"]), "x' OR IsDeleted = false OR Name = '")
            )
        ).toEqual({ clause: String.raw`Name = 'x\' OR IsDeleted = false OR Name = \''`, alwaysFalse: false });
    });

    it("preserves regular inArray pushdown", () => {
        expect(
            convertLoadSubsetFilter(inArray(new IR.PropRef<string>(["Status__c"]), ["Open", "Closed"]))
        ).toEqual({ clause: "Status__c IN ('Open', 'Closed')", alwaysFalse: false });
    });
});

describe("buildSoqlQuery", () => {
    it("builds SELECT/FROM/WHERE/ORDER BY/LIMIT/OFFSET queries", () => {
        expect(
            buildSoqlQuery({
                objectType: "Account",
                selectedProperties: ["Id", "Name"],
                where: { clause: "Name = 'Acme'", alwaysFalse: false },
                orderBy: "Name ASC",
                limit: 50,
                offset: 10,
            })
        ).toBe("SELECT Id, Name FROM Account WHERE Name = 'Acme' ORDER BY Name ASC LIMIT 50 OFFSET 10");
    });

    it("rejects unsafe identifiers", () => {
        expect(() =>
            buildSoqlQuery({ objectType: "Account; DROP TABLE", selectedProperties: ["Id"] })
        ).toThrow(/Invalid Salesforce identifier/);
    });
});
