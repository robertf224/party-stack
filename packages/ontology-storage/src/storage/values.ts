import { Schema } from "effect";
import { Temporal } from "temporal-polyfill";

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
export function encodeValue(value: unknown): string {
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

export function decodeValue(encoded: string): unknown {
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
