import { Temporal } from "temporal-polyfill";

const TAG = "__party_stack_cloudflare_runtime_value_v1__";
const HOLE = Symbol("runtime-array-hole");

interface TaggedValue {
    [TAG]: "escaped-object" | "hole" | "temporal-instant" | "temporal-plain-date";
    value?: unknown;
}

function isPlainObject(value: object): value is Record<string, unknown> {
    const prototype = Object.getPrototypeOf(value) as unknown;
    return prototype === Object.prototype || prototype === null;
}

export function encodeRuntimeValue(value: unknown): unknown {
    const tag =
        value && typeof value === "object"
            ? (
                  value as {
                      [Symbol.toStringTag]?: unknown;
                  }
              )[Symbol.toStringTag]
            : undefined;
    if (tag === "Temporal.Instant") {
        return {
            [TAG]: "temporal-instant",
            value: (value as Temporal.Instant).toString(),
        } satisfies TaggedValue;
    }
    if (tag === "Temporal.PlainDate") {
        return {
            [TAG]: "temporal-plain-date",
            value: (value as Temporal.PlainDate).toString(),
        } satisfies TaggedValue;
    }
    if (Array.isArray(value)) {
        return Array.from({ length: value.length }, (_entry, index) =>
            index in value
                ? encodeRuntimeValue(value[index])
                : ({
                      [TAG]: "hole",
                  } satisfies TaggedValue)
        );
    }
    if (value && typeof value === "object" && isPlainObject(value)) {
        const entries = Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, encodeRuntimeValue(entry)])
        );
        return TAG in value
            ? ({
                  [TAG]: "escaped-object",
                  value: entries,
              } satisfies TaggedValue)
            : entries;
    }
    return value;
}

function decodeTaggedValue(value: Record<string, unknown>): unknown {
    if (!(TAG in value)) return undefined;
    const tag = value[TAG];
    if (tag === "hole") return HOLE;
    if (tag === "temporal-instant" && typeof value.value === "string") {
        return Temporal.Instant.from(value.value);
    }
    if (tag === "temporal-plain-date" && typeof value.value === "string") {
        return Temporal.PlainDate.from(value.value);
    }
    if (
        tag === "escaped-object" &&
        value.value &&
        typeof value.value === "object" &&
        !Array.isArray(value.value)
    ) {
        return Object.fromEntries(
            Object.entries(value.value).map(([key, entry]) => [key, decodeRuntimeValue(entry)])
        );
    }
    return undefined;
}

export function decodeRuntimeValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.reduce<unknown[]>((entries, entry, index) => {
            const decoded = decodeRuntimeValue(entry);
            if (decoded !== HOLE) {
                entries[index] = decoded;
            }
            return entries;
        }, new Array(value.length));
    }
    if (value && typeof value === "object" && isPlainObject(value)) {
        const tagged = decodeTaggedValue(value);
        if (tagged !== undefined) return tagged;
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, decodeRuntimeValue(entry)])
        );
    }
    return value;
}
