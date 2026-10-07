import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { cloneValue } from "./valueCodec.js";

describe("coordination value codec", () => {
    it("preserves every Temporal kind without global constructor registration", () => {
        const values = [
            Temporal.Instant.from("2026-10-07T12:00:00.123456789Z"),
            Temporal.PlainDate.from("2026-10-07"),
            Temporal.PlainDateTime.from("2026-10-07T12:00:00"),
            Temporal.PlainMonthDay.from("10-07"),
            Temporal.PlainTime.from("12:00:00"),
            Temporal.PlainYearMonth.from("2026-10"),
            Temporal.ZonedDateTime.from("2026-10-07T12:00:00+00:00[UTC]"),
            Temporal.Duration.from("P1D"),
        ];
        const cloned = cloneValue(values);
        for (const [index, value] of values.entries()) {
            expect(Object.getPrototypeOf(cloned[index])).toBe(Object.getPrototypeOf(value));
            expect(String(cloned[index])).toBe(value.toString());
        }
    });

    it("preserves cycles, aliases, maps, sets, sparse arrays, and cloneable native values", () => {
        const instant = Temporal.Instant.from("2026-10-07T12:00:00Z");
        const collision = { __party_stack_coordination_value__: "temporal", kind: "Temporal.Instant", value: "ordinary data" };
        const sparse = new Array<unknown>(2);
        sparse[1] = undefined;
        const source: Record<string, unknown> = {
            instant, alias: instant, collision,
            map: new Map([[instant, new Set([instant])]]),
            bigint: 2n ** 100n, date: new Date("2026-10-07T00:00:00Z"),
            nan: NaN, infinity: Infinity, negativeInfinity: -Infinity,
            undefined, bytes: new Uint8Array([1, 2]), blob: new Blob(["hello"]),
            sparse,
            dangerousKeys: JSON.parse('{"__proto__":{"polluted":true}}') as unknown,
        };
        source.self = source;
        const cloned = cloneValue(source);
        expect(cloned).not.toBe(source);
        expect(cloned.self).toBe(cloned);
        expect(cloned.alias).toBe(cloned.instant);
        expect(cloned.instant).toBeInstanceOf(Temporal.Instant);
        expect(cloned.collision).toEqual(collision);
        expect((cloned.map as Map<unknown, Set<unknown>>).get(cloned.instant)?.has(cloned.instant)).toBe(true);
        for (const key of ["bigint", "date", "nan", "infinity", "negativeInfinity", "undefined", "bytes"]) expect(cloned[key]).toEqual(source[key]);
        expect(cloned.blob).toBeInstanceOf(Blob);
        expect(0 in (cloned.sparse as unknown[])).toBe(false);
        expect(1 in (cloned.sparse as unknown[])).toBe(true);
        expect(Object.hasOwn(cloned.dangerousKeys as object, "__proto__")).toBe(true);
        expect(Object.getPrototypeOf(cloned.dangerousKeys)).toBe(Object.prototype);
    });
});
