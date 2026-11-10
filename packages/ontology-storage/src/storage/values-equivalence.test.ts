import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { Temporal } from "temporal-polyfill";
import { describe, expect } from "vitest";
import { decodeValue, encodeValue } from "./values.js";

// Frozen version-2 reference: retain the pre-optimization Schema encoder
// independently of production encodeValue so format changes cannot agree by accident.
type EncodedValue =
    | null
    | boolean
    | string
    | number
    | { readonly tag: "undefined" }
    | { readonly tag: "bigint" | "instant" | "plainDate"; readonly value: string }
    | { readonly tag: "date"; readonly value: number }
    | { readonly tag: "array" | "set"; readonly value: readonly EncodedValue[] }
    | { readonly tag: "object"; readonly value: readonly (readonly [string, EncodedValue])[] }
    | { readonly tag: "map"; readonly value: readonly (readonly [EncodedValue, EncodedValue])[] };

const EncodedValueSchema: Schema.Codec<EncodedValue> = Schema.suspend(() =>
    Schema.Union([
        Schema.Null,
        Schema.Boolean,
        Schema.String,
        Schema.Finite,
        Schema.Struct({ tag: Schema.Literal("undefined") }),
        Schema.Struct({ tag: Schema.Literal("bigint"), value: Schema.String.check(Schema.isStringBigInt()) }),
        Schema.Struct({ tag: Schema.Literals(["instant", "plainDate"]), value: Schema.String }),
        Schema.Struct({ tag: Schema.Literal("date"), value: Schema.Finite }),
        Schema.Struct({ tag: Schema.Literals(["array", "set"]), value: Schema.Array(EncodedValueSchema) }),
        Schema.Struct({
            tag: Schema.Literal("object"),
            value: Schema.Array(Schema.Tuple([Schema.String, EncodedValueSchema])),
        }),
        Schema.Struct({
            tag: Schema.Literal("map"),
            value: Schema.Array(Schema.Tuple([EncodedValueSchema, EncodedValueSchema])),
        }),
    ])
);
// Every container is wrapped, so application objects/arrays cannot collide with type tags.
// Version 2 replaces the unreleased reference-graph prototype; it does not decode that format.
const Storage = Schema.fromJsonString(
    Schema.Struct({ version: Schema.Literal(2), value: EncodedValueSchema })
);
const encodeStorage = Schema.encodeSync(Storage);
const decodeStorage = Schema.decodeUnknownSync(Storage);

/** JSON-shaped values with a small, explicit set of additional database value types. */
function encodeReference(value: unknown): string {
    const ancestors = new WeakSet<object>();
    const encode = (value: unknown): EncodedValue => {
        if (value === null || typeof value === "string" || typeof value === "boolean") return value;
        if (typeof value === "number") {
            if (!Number.isFinite(value)) throw new Error("Only finite numbers can be persisted.");
            return value;
        }
        if (value === undefined) return { tag: "undefined" };
        if (typeof value === "bigint") return { tag: "bigint", value: String(value) };
        if (typeof value !== "object") throw new Error(`Cannot persist ${typeof value}`);
        if (value instanceof Date) {
            if (!Number.isFinite(value.getTime())) throw new Error("Invalid dates cannot be persisted.");
            return { tag: "date", value: value.getTime() };
        }
        const temporal = Reflect.get(value, Symbol.toStringTag) as unknown;
        if (temporal === "Temporal.Instant" || temporal === "Temporal.PlainDate")
            return {
                tag: temporal === "Temporal.Instant" ? "instant" : "plainDate",
                value: String(value as { toString(): string }),
            };
        if (typeof temporal === "string" && temporal.startsWith("Temporal."))
            throw new Error(`Unsupported Temporal type: ${temporal}`);
        if (ancestors.has(value)) throw new Error("Cyclic values are not supported.");
        ancestors.add(value);
        try {
            if (Array.isArray(value)) return { tag: "array", value: Array.from(value, encode) };
            if (value instanceof Map)
                return { tag: "map", value: [...value].map(([key, item]) => [encode(key), encode(item)]) };
            if (value instanceof Set) return { tag: "set", value: [...value].map(encode) };
            const prototype: unknown = Object.getPrototypeOf(value);
            if (prototype !== Object.prototype && prototype !== null)
                throw new Error("Custom classes and binary values require an explicit codec.");
            if (
                Object.getOwnPropertySymbols(value).some((symbol) =>
                    Object.prototype.propertyIsEnumerable.call(value, symbol)
                )
            )
                throw new Error("Enumerable symbol keys are not supported.");
            return {
                tag: "object",
                value: Object.keys(value)
                    .sort()
                    .map((key) => [key, encode(Reflect.get(value, key))]),
            };
        } finally {
            ancestors.delete(value);
        }
    };
    return encodeStorage({ version: 2, value: encode(value) });
}

function decodeReference(encoded: string): unknown {
    const stored = decodeStorage(encoded);
    const decode = (value: EncodedValue): unknown => {
        if (value === null || typeof value !== "object") return value;
        switch (value.tag) {
            case "undefined":
                return undefined;
            case "bigint":
                return BigInt(value.value);
            case "instant":
                return Temporal.Instant.from(value.value);
            case "plainDate":
                return Temporal.PlainDate.from(value.value);
            case "date": {
                const date = new Date(value.value);
                if (!Number.isFinite(date.getTime())) throw new Error("Invalid persisted date.");
                return date;
            }
            case "array":
                return value.value.map(decode);
            case "set":
                return new Set(value.value.map(decode));
            case "map":
                return new Map(value.value.map(([key, item]) => [decode(key), decode(item)]));
            case "object":
                return Object.fromEntries(value.value.map(([key, item]) => [key, decode(item)]));
        }
    };
    return decode(stored.value);
}

const inputs = Arbitrary.schema(
    Schema.Struct({
        json: Schema.Json,
        entries: Schema.Array(Schema.Tuple([Schema.String, Schema.Json])),
        integer: Schema.BigInt,
        timestamp: Schema.Int.check(
            Schema.isBetween({ minimum: -1_000_000_000_000, maximum: 1_000_000_000_000 })
        ),
        flag: Schema.Boolean,
    })
);

describe("version-2 storage encoder equivalence", () => {
    // @effect/vitest preserves the shrunk counterexample and replay token on
    // failure. Set arbitrary.replay to that token when reproducing a failure.
    it.effect.prop(
        "matches the independent schema encoder byte for byte for rich nested values",
        [inputs],
        ([input]) =>
            Effect.sync(() => {
                const shared = { payload: input.json, missing: undefined };
                const instant = Temporal.Instant.fromEpochNanoseconds(BigInt(input.timestamp));
                const value = {
                    nested: [input.json, shared, shared, undefined, input.flag],
                    integer: input.integer,
                    date: new Date(input.timestamp),
                    instant,
                    day: Temporal.PlainDate.from("2026-11-08"),
                    object: Object.fromEntries([
                        ...input.entries,
                        ["__proto__", { safe: true }],
                        ["tag", "undefined"],
                        ["value", input.json],
                    ]),
                    map: new Map<unknown, unknown>([
                        [input.integer, new Set<unknown>([input.json, undefined, input.integer, instant])],
                        [shared, new Map(input.entries)],
                    ]),
                    sparse: Array(3),
                };
                const expected = encodeReference(value);
                const actual = encodeValue(value);
                expect(actual).toBe(expected);
                expect(decodeValue(actual)).toEqual(decodeReference(expected));
            }),
        { arbitrary: { runs: 2000, size: 10, seed: "storage-encoder-v2-rich" }, timeout: 30_000 }
    );

    it.effect.prop(
        "preserves generated JSON values without changing the wire format",
        [Schema.Json],
        ([value]) =>
            Effect.sync(() => {
                const encoded = encodeValue(value);
                expect(encoded).toBe(encodeReference(value));
                expect(decodeValue(encoded)).toEqual(decodeReference(encoded));
            }),
        { arbitrary: { runs: 2000, size: 12, seed: "storage-encoder-v2-json" }, timeout: 30_000 }
    );

    it.effect.prop(
        "still rejects malformed persisted envelopes through the schema decoder",
        [Schema.Json],
        ([value]) =>
            Effect.sync(() => {
                for (const stored of [
                    { version: 1, value },
                    { version: 2, value: { tag: "unknown", value } },
                    { version: 2, value: { tag: "object", value: [["missing-value"]] } },
                    { version: 2, value: { tag: "map", value: [[value]] } },
                    { version: 2, value: { tag: "bigint", value: "invalid" } },
                    { version: 2, value: { tag: "date", value: 1e100 } },
                    { version: 2, value: { tag: "instant", value: "invalid" } },
                    { version: 2, value: { tag: "plainDate", value: "invalid" } },
                ]) {
                    const encoded = JSON.stringify(stored);
                    expect(() => decodeReference(encoded)).toThrow();
                    expect(() => decodeValue(encoded)).toThrow();
                }
            }),
        { arbitrary: { runs: 200, size: 6, seed: "storage-encoder-v2-invalid" } }
    );

    const cases: readonly [string, () => unknown][] = [
        ["negative zero", () => -0],
        ["null-prototype object", () => Object.assign(Object.create(null), { a: undefined, b: 1 })],
        [
            "non-enumerable symbol",
            () => Object.defineProperty({ a: 1 }, Symbol("hidden"), { value: () => 0 }),
        ],
        ["enumerable symbol", () => ({ [Symbol("invalid")]: 1 })],
        ["infinite number", () => Infinity],
        ["negative infinite number", () => -Infinity],
        ["NaN", () => NaN],
        ["invalid date", () => new Date(NaN)],
        ["binary buffer", () => new ArrayBuffer(4)],
        ["binary array", () => new Uint8Array([1])],
        ["custom class", () => new (class Value {})()],
        ["function", () => () => {}],
        ["symbol", () => Symbol("invalid")],
        ["unsupported temporal", () => Temporal.Duration.from("P1D")],
        [
            "Temporal lookalike",
            () => ({
                [Symbol.toStringTag]: "Temporal.Instant",
                toString: () => "invalid",
            }),
        ],
        [
            "cyclic object",
            () => {
                const value: Record<string, unknown> = {};
                value.self = value;
                return value;
            },
        ],
        [
            "cyclic array",
            () => {
                const value: unknown[] = [];
                value.push(value);
                return value;
            },
        ],
        [
            "cyclic map",
            () => {
                const value = new Map();
                value.set("self", value);
                return value;
            },
        ],
        [
            "cyclic set",
            () => {
                const value = new Set();
                value.add(value);
                return value;
            },
        ],
        [
            "date changing to infinity",
            () => {
                let calls = 0;
                return new (class extends Date {
                    override getTime() {
                        return ++calls === 1 ? 1 : Infinity;
                    }
                })();
            },
        ],
        [
            "date changing between valid times",
            () => {
                let calls = 0;
                return new (class extends Date {
                    override getTime() {
                        return ++calls;
                    }
                })();
            },
        ],
    ];
    it.effect.each(cases)("preserves acceptance and exact bytes for %s", ([, create]) =>
        Effect.sync(() => {
            let expected: string;
            try {
                expected = encodeReference(create());
            } catch {
                expect(() => encodeValue(create())).toThrow();
                return;
            }
            const actual = encodeValue(create());
            expect(actual).toBe(expected);
            let expectedDecoded: unknown;
            try {
                expectedDecoded = decodeReference(expected);
            } catch {
                expect(() => decodeValue(actual)).toThrow();
                return;
            }
            expect(decodeValue(actual)).toEqual(expectedDecoded);
        })
    );
});
