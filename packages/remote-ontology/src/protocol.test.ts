import { describe, expect, it } from "vitest";
import { Temporal } from "temporal-polyfill";
import { parseRemoteOntologyJson, serializeRemoteOntologyJson } from "./protocol.js";

describe("remote ontology JSON codec", () => {
    it("round-trips Temporal values before native JSON stringification erases their type", () => {
        const payload = {
            createdAt: Temporal.Instant.from("2026-05-28T22:11:00Z"),
            dueDate: Temporal.PlainDate.from("2026-05-29"),
        };

        const serialized = serializeRemoteOntologyJson(payload);
        const parsed = parseRemoteOntologyJson(serialized) as typeof payload;

        expect(serialized).toContain("Temporal.Instant");
        expect(parsed.createdAt).toBeInstanceOf(Temporal.Instant);
        expect(parsed.dueDate).toBeInstanceOf(Temporal.PlainDate);
        expect(parsed.createdAt.equals(payload.createdAt)).toBe(true);
        expect(parsed.dueDate.equals(payload.dueDate)).toBe(true);
    });
});
