import { Temporal } from "temporal-polyfill";
import { describe, expect, test } from "vitest";
import { scalarKey } from "../query/evaluate.js";
import { Table } from "../table-api.js";
import { decodeValue, encodeValue } from "./values.js";

describe("portable database values", () => {
    test("object identities ignore insertion order while ordered containers retain their order", () => {
        expect(encodeValue({ b: [{ y: 2, x: 1 }], a: 0 })).toBe(encodeValue({ a: 0, b: [{ x: 1, y: 2 }] }));
        expect(encodeValue([1, 2])).not.toBe(encodeValue([2, 1]));
        expect(encodeValue({ a: undefined })).not.toBe(encodeValue({}));
    });
    test("supports explicit codecs without requiring Effect Schema", () => {
        class Count {
            constructor(readonly value: bigint) {}
        }
        const table = Table.make<Count>({
            name: "counts",
            codec: { encode: (count) => count.value, decode: (value) => new Count(value as bigint) },
        });
        const copy = table.decode(table.encode(new Count(9007199254740993n)));
        expect(copy).toBeInstanceOf(Count);
        expect(copy.value).toBe(9007199254740993n);
    });
    test("round-trips nested JSON, bigint, Temporal, Date, undefined, Map, and Set", () => {
        const input = {
            nested: [{ id: 9007199254740993n, missing: undefined, text: "abc", flags: [true, null, 1.5] }],
            instant: Temporal.Instant.from("2026-10-19T12:00:00.123456789Z"),
            day: Temporal.PlainDate.from("2026-10-20"),
            date: new Date("2026-10-19T12:00:00Z"),
            map: new Map<unknown, unknown>([[{ id: 1n }, new Set([2n, 3n])]]),
        };
        expect(decodeValue(encodeValue(input))).toEqual(input);
    });
    test("tags never collide with ordinary application data or prototype-named fields", () => {
        const input = Object.fromEntries([
            ["__proto__", { safe: true }],
            ["tag", "bigint"],
            ["value", "123"],
            ["array", ["bigint", "123"]],
        ]);
        const copy = decodeValue(encodeValue(input));
        expect(copy).toEqual(input);
        expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
        expect(Object.hasOwn(copy as object, "__proto__")).toBe(true);
        expect(({} as Record<string, unknown>).safe).toBeUndefined();
    });
    test("shared objects become independent values; cycles and binary/extra classes are rejected", () => {
        const shared = { nested: [1n] };
        const copy = decodeValue(encodeValue({ a: shared, b: shared })) as { a: unknown; b: unknown };
        expect(copy.a).toEqual(copy.b);
        expect(copy.a).not.toBe(copy.b);
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        const map = new Map();
        map.set("self", map);
        for (const value of [
            cycle,
            map,
            new ArrayBuffer(4),
            new Uint8Array([1]),
            /extra/,
            new (class {})(),
            () => {},
            Symbol("extra"),
            NaN,
            Infinity,
            new Date(NaN),
        ])
            expect(() => encodeValue(value)).toThrow(Error);
        expect(() => encodeValue(Temporal.Duration.from("P1D"))).toThrow("Unsupported Temporal");
    });
    test("validates malformed storage with Effect's JSON schema codec", () => {
        for (const stored of [
            { version: 1, root: null, nodes: [] },
            { version: 2, value: { tag: "bigint", value: "not-an-integer" } },
            { version: 2, value: { tag: "object", value: [["missing-value"]] } },
            { version: 2, value: { tag: "array", value: [{ tag: "buffer", value: [] }] } },
            { version: 2, value: { tag: "date", value: 1e100 } },
            { version: 2, value: { tag: "instant", value: "not-a-date" } },
        ])
            expect(() => decodeValue(JSON.stringify(stored))).toThrow(Error);
    });
    test("bigint index ordering has no floating point conversion", () => {
        const values = [-(10n ** 100n), -100n, -99n, -10n, -9n, -1n, 0n, 1n, 9n, 10n, 99n, 100n, 10n ** 100n];
        expect([...values].reverse().sort((a, b) => (scalarKey(a) < scalarKey(b) ? -1 : 1))).toEqual(values);
    });
});
