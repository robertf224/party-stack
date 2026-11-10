import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vite-plus/test";
import { buildSoqlQuery, serializeSoqlLiteral } from "./soql.js";

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
            buildSoqlQuery({
                objectType: "Account; DROP TABLE",
                selectedProperties: ["Id"],
            })
        ).toThrow(/Invalid Salesforce identifier/);
    });
});
