import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { decodeOutboxRequest } from "./outboxValues.js";

describe("legacy outbox values", () => {
    it("preserves graph references while decoding legacy values", () => {
        const tagged = { __party_stack_outbox_value_type__: "Temporal.Instant", value: "2026-10-07T12:00:00Z" };
        const parameters: Record<string, unknown> = { first: tagged, second: tagged, map: new Map([[tagged, new Set([tagged])]]) };
        parameters.self = parameters;
        const decoded = decodeOutboxRequest({ actionTypeName: "createTask", idempotencyKey: "legacy", parameters }).parameters;
        expect(decoded.self).toBe(decoded);
        expect(decoded.first).toBeInstanceOf(Temporal.Instant);
        expect(decoded.first).toBe(decoded.second);
        expect((decoded.map as Map<unknown, Set<unknown>>).get(decoded.first)?.has(decoded.first)).toBe(true);
    });

    it("still executes stored legacy Temporal tags alongside new raw values", () => {
        const instant = Temporal.Instant.from("2026-10-07T12:00:00Z");
        const request = decodeOutboxRequest({
            actionTypeName: "createTask", idempotencyKey: "legacy",
            parameters: {
                now: { __party_stack_outbox_value_type__: "Temporal.Instant", value: instant.toString() },
                dates: [{ __party_stack_outbox_value_type__: "Temporal.PlainDate", value: "2026-10-07" }],
                raw: instant,
            },
        });
        expect(request.parameters.now).toBeInstanceOf(Temporal.Instant);
        expect(String(request.parameters.now)).toBe(instant.toString());
        const dates = request.parameters.dates as unknown[];
        expect(dates[0]).toBeInstanceOf(Temporal.PlainDate);
        expect(String(dates[0])).toBe("2026-10-07");
        expect(request.parameters.raw).toBe(instant);
    });
});
