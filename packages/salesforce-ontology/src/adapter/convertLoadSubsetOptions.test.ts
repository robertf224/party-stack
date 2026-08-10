import { eq, gt, IR, lt } from "@tanstack/db";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
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
        expect(filter).toEqual({
            clause: "CreatedDate > 2026-07-27T12:00:00Z",
            alwaysFalse: false,
        });
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
        ).toBe(
            "SELECT Id, Name FROM Account WHERE Name = 'Acme' ORDER BY Name ASC LIMIT 50 OFFSET 10"
        );
    });

    it("rejects unsafe identifiers", () => {
        expect(() =>
            buildSoqlQuery({
                objectType: "Account; DROP TABLE",
                selectedProperties: ["Id"],
            })
        ).toThrow(/Invalid Salesforce identifier/);
    });
});
