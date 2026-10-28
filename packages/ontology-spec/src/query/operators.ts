import { Temporal } from "temporal-polyfill";
import { certain, uncertain } from "../utils/uncertain.js";
import type { Uncertain } from "../utils/uncertain.js";

const temporalTag = (value: unknown): string | undefined =>
    value !== null && typeof value === "object" ? Reflect.get(value, Symbol.toStringTag) : undefined;
export function equalValues(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a instanceof Date || b instanceof Date)
        return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    const tag = temporalTag(a),
        otherTag = temporalTag(b);
    if ([tag, otherTag].some((tag) => tag === "Temporal.Instant" || tag === "Temporal.PlainDate"))
        return tag === temporalTag(b) && String(a) === String(b);
    if (Array.isArray(a) && Array.isArray(b))
        return a.length === b.length && a.every((v, i) => equalValues(v, b[i]));
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
        if (
            ![null, Object.prototype].includes(Object.getPrototypeOf(a)) ||
            ![null, Object.prototype].includes(Object.getPrototypeOf(b))
        )
            return false;
        const keys = Object.keys(a);
        return (
            keys.length === Object.keys(b).length &&
            keys.every((k) => Object.hasOwn(b, k) && equalValues(Reflect.get(a, k), Reflect.get(b, k)))
        );
    }
    return false;
}
/** Ordered comparisons require present values from the same scalar family. */
export function compareValues(a: unknown, b: unknown): number | undefined {
    if (a == null || b == null) return undefined;
    if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === "number" && typeof b === "number") {
        if (!Number.isFinite(a) || !Number.isFinite(b))
            throw new TypeError("Ordered numbers must be finite.");
        return a < b ? -1 : a > b ? 1 : 0;
    }
    if (typeof a === "bigint" && typeof b === "bigint") return a < b ? -1 : a > b ? 1 : 0;
    if (a instanceof Date && b instanceof Date) return compareValues(a.getTime(), b.getTime());
    const tag = temporalTag(a);
    if (tag && tag === temporalTag(b)) {
        if (tag === "Temporal.Instant")
            return compareValues(
                Reflect.get(a as object, "epochNanoseconds"),
                Reflect.get(b as object, "epochNanoseconds")
            );
        if (tag === "Temporal.PlainDate") return Temporal.PlainDate.compare(String(a), String(b));
    }
    throw new TypeError("Ordered operands have incompatible scalar types.");
}
/** SQL wildcards over UTF-16 strings; no implicit regexp or escape syntax. */
export function matchPattern(value: unknown, pattern: unknown, insensitive = false): boolean {
    if (value == null || pattern == null) return false;
    if (typeof value !== "string" || typeof pattern !== "string")
        throw new TypeError("LIKE operands must be strings.");
    const input = insensitive ? value.toLowerCase() : value;
    const search = insensitive ? pattern.toLowerCase() : pattern;
    let i = 0,
        p = 0,
        star = -1,
        restart = 0;
    while (i < input.length) {
        if (search[p] === "%") {
            star = p++;
            restart = i;
        } else if (p < search.length && (search[p] === "_" || search[p] === input[i])) {
            i++;
            p++;
        } else if (star >= 0) {
            p = star + 1;
            i = ++restart;
        } else return false;
    }
    while (search[p] === "%") p++;
    return p === search.length;
}
export function booleanValue(value: unknown): boolean {
    if (typeof value !== "boolean") throw new TypeError("A condition must evaluate to a boolean.");
    return value;
}
export function evaluateOperator(kind: string, args: readonly Uncertain<unknown>[]): Uncertain<unknown> {
    if (kind === "and" || kind === "or") {
        const terminal = kind === "or";
        if (args.some((v) => v.certain && booleanValue(v.value) === terminal)) return certain(terminal);
        return args.some((v) => !v.certain) ? uncertain() : certain(!terminal);
    }
    if (kind === "coalesce") {
        for (const value of args) {
            if (!value.certain) return uncertain();
            if (value.value != null) return value;
        }
        return certain(undefined);
    }
    if (args.some((v) => !v.certain)) return uncertain();
    const values = args.map((v) => (v.certain ? v.value : undefined)),
        a = values[0],
        b = values[1];
    if (kind === "not") return certain(!booleanValue(a));
    if (kind === "eq" || kind === "ne") return certain(equalValues(a, b) === (kind === "eq"));
    if (["lt", "lte", "gt", "gte"].includes(kind)) {
        const c = compareValues(a, b);
        return certain(
            c !== undefined &&
                (kind === "lt" ? c < 0 : kind === "lte" ? c <= 0 : kind === "gt" ? c > 0 : c >= 0)
        );
    }
    if (kind === "in" || kind === "contains") {
        const array = kind === "in" ? b : a,
            value = kind === "in" ? a : b;
        if (array == null) return certain(false);
        if (!Array.isArray(array)) throw new TypeError("Membership requires a list.");
        return certain(array.some((v) => equalValues(v, value)));
    }
    if (kind === "like" || kind === "ilike") return certain(matchPattern(a, b, kind === "ilike"));
    if (kind === "concat") {
        if (values.some((v) => typeof v !== "string"))
            throw new TypeError("CONCAT operands must be strings.");
        return certain(values.join(""));
    }
    if (["add", "subtract", "multiply", "divide"].includes(kind)) {
        if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b))
            throw new TypeError("Arithmetic requires finite numbers.");
        const result =
            kind === "add" ? a + b : kind === "subtract" ? a - b : kind === "multiply" ? a * b : a / b;
        if (!Number.isFinite(result)) throw new TypeError("Arithmetic produced a nonfinite result.");
        return certain(result);
    }
    throw new TypeError(`Unsupported operator ${kind}.`);
}
