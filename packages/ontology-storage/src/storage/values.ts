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

// Every container is wrapped, so application objects/arrays cannot collide with type tags.
// Version 2 replaces the unreleased reference-graph prototype; it does not decode that format.
// Envelope: { version: 2, value: EncodedValue }. The frozen Schema reference lives in
// values-equivalence.test.ts, which checks this hand-written decoder against it.

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
            // A Date subclass can return a different value on this second read.
            const timestamp = value.getTime();
            if (!Number.isFinite(timestamp)) throw new Error("Invalid dates cannot be persisted.");
            return { tag: "date", value: timestamp };
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
    // Only fresh tagged containers and validated scalar values reach JSON.
    // Persisted input is still fully validated by decodeValue below.
    return JSON.stringify({ version: 2, value: encode(value) });
}

const invalid = (): never => {
    throw new Error("Invalid persisted value encoding.");
};
const isTagged = (value: object): value is { readonly tag: unknown; readonly value?: unknown } =>
    !Array.isArray(value) && "tag" in value;
// Same accepted text as Schema.isStringBigInt().
const bigIntPattern = /^-?\d+$/;

/** Validate the version-2 envelope while decoding in one pass. This accepts
 * exactly the version-2 Schema format; a recursive Schema union decoder was too
 * slow for large persisted rows on mobile JavaScript engines.
 */
export function decodeValue(encoded: string): unknown {
    let stored: unknown;
    try {
        stored = JSON.parse(encoded);
    } catch {
        return invalid();
    }
    if (
        stored === null ||
        typeof stored !== "object" ||
        Array.isArray(stored) ||
        (stored as { version?: unknown }).version !== 2 ||
        !("value" in stored)
    )
        return invalid();
    const decode = (value: unknown): unknown => {
        if (value === null || typeof value === "string" || typeof value === "boolean") return value;
        if (typeof value === "number") return Number.isFinite(value) ? value : invalid();
        if (typeof value !== "object" || !isTagged(value)) return invalid();
        switch (value.tag) {
            case "undefined":
                return undefined;
            case "bigint":
                return typeof value.value === "string" && bigIntPattern.test(value.value)
                    ? BigInt(value.value)
                    : invalid();
            case "instant":
                return typeof value.value === "string" ? Temporal.Instant.from(value.value) : invalid();
            case "plainDate":
                return typeof value.value === "string" ? Temporal.PlainDate.from(value.value) : invalid();
            case "date": {
                if (typeof value.value !== "number" || !Number.isFinite(value.value)) return invalid();
                const date = new Date(value.value);
                if (!Number.isFinite(date.getTime())) throw new Error("Invalid persisted date.");
                return date;
            }
            case "array":
                return Array.isArray(value.value) ? value.value.map(decode) : invalid();
            case "set":
                return Array.isArray(value.value) ? new Set(value.value.map(decode)) : invalid();
            case "map":
                return Array.isArray(value.value)
                    ? new Map(
                          value.value.map((entry: unknown) =>
                              Array.isArray(entry) && entry.length === 2
                                  ? [decode(entry[0]), decode(entry[1])]
                                  : invalid()
                          )
                      )
                    : invalid();
            case "object": {
                if (!Array.isArray(value.value)) return invalid();
                const result: Record<string, unknown> = {};
                for (const entry of value.value as unknown[]) {
                    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string")
                        return invalid();
                    const decoded = decode(entry[1]);
                    // Match Object.fromEntries, which defines an own "__proto__" data property.
                    if (entry[0] === "__proto__")
                        Object.defineProperty(result, entry[0], {
                            value: decoded,
                            enumerable: true,
                            writable: true,
                            configurable: true,
                        });
                    else result[entry[0]] = decoded;
                }
                return result;
            }
            default:
                return invalid();
        }
    };
    return decode((stored as { value: unknown }).value);
}
