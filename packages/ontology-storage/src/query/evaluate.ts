import { Temporal } from "temporal-polyfill";
import { filterOperand, inValues } from "./filter.js";
import { validateQueryShape } from "./schema.js";
import type { Cursor, Field, Filter, Key, Query, Row, Scalar } from "../model.js";
import type { Expression } from "@party-stack/ontology-spec";

// ASCII encodings give IDB and SQL binary collations exactly the same ordering.
const textKey = (value: string): string => {
    let result = "";
    for (let i = 0; i < value.length; i++) result += value.charCodeAt(i).toString(16).padStart(4, "0");
    return result;
};
function numberKey(value: number): string {
    if (!Number.isFinite(value)) throw new Error("Only finite numbers and valid dates are queryable.");
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value === 0 ? 0 : value);
    const bytes = new Uint8Array(view.buffer);
    if (bytes[0]! & 128) for (let i = 0; i < 8; i++) bytes[i] = bytes[i]! ^ 255;
    else bytes[0] = bytes[0]! ^ 128;
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function scalarKey(value: unknown): string {
    if (value === undefined) return "0";
    if (value === null) return "1";
    if (typeof value === "boolean") return value ? "21" : "20";
    if (typeof value === "number") return `3${numberKey(value)}`;
    if (typeof value === "bigint") {
        const negative = value < 0n;
        const digits = (negative ? -value : value).toString();
        const length = digits.length.toString(16).padStart(8, "0");
        const encoded = length + digits;
        return negative
            ? `40${encoded.replace(/[0-9a-f]/g, (digit) => (15 - parseInt(digit, 16)).toString(16))}`
            : `41${encoded}`;
    }
    if (value instanceof Date) return `5${numberKey(value.getTime())}`;
    if (typeof value === "string") return `6${textKey(value)}`;
    if (typeof value === "object") {
        const tag = Reflect.get(value, Symbol.toStringTag) as unknown;
        if (tag === "Temporal.Instant")
            return `7${String(Temporal.Instant.from(String(value as { toString(): string })).epochNanoseconds + 8_640_000_000_000_000_000_000n).padStart(23, "0")}`;
        if (tag === "Temporal.PlainDate") {
            const date = Temporal.PlainDate.from(String(value as { toString(): string })).withCalendar(
                "iso8601"
            );
            return `8${String(date.year + 1_000_000).padStart(7, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
        }
    }
    throw new Error("Query fields must be scalar values. Use a schema codec for persisted rich values.");
}
export const keyCode = (key: Key): string => {
    if (typeof key !== "string" && typeof key !== "number")
        throw new Error("Row keys must be strings or finite numbers.");
    return scalarKey(key);
};
export function decodeKey(encoded: string): Key {
    if (encoded[0] === "6") {
        let result = "";
        for (let i = 1; i < encoded.length; i += 4)
            result += String.fromCharCode(parseInt(encoded.slice(i, i + 4), 16));
        return result;
    }
    const bytes = Uint8Array.from(encoded.slice(1).match(/../g) ?? [], (byte) => parseInt(byte, 16));
    if (bytes[0]! & 128) bytes[0] = bytes[0]! ^ 128;
    else for (let i = 0; i < 8; i++) bytes[i] = bytes[i]! ^ 255;
    return new DataView(bytes.buffer).getFloat64(0);
}
export function readField(value: unknown, path: Field): unknown {
    for (const part of path.path) {
        if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
        value = Reflect.get(value, part);
    }
    return value;
}
export const sameField = (a: Field, b: Field): boolean =>
    a.path.length === b.path.length && a.path.every((part, i) => part === b.path[i]);
export const compareScalar = (a: unknown, b: unknown): number => {
    // Index keys need a portable encoding; in-process comparisons do not.
    // UTF-16 lexicographic and finite numeric order are exactly that encoding's
    // order, without allocating two strings for every predicate/sort comparison.
    if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === "number" && typeof b === "number") {
        if (!Number.isFinite(a) || !Number.isFinite(b))
            throw new Error("Only finite numbers and valid dates are queryable.");
        return a < b ? -1 : a > b ? 1 : 0;
    }
    if (typeof a === "bigint" && typeof b === "bigint") return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
    const left = scalarKey(a),
        right = scalarKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
};
/** SQL-style wildcards, matching TanStack's UTF-16 / JS lowercase semantics.
 * Backslashes and regexp punctuation are ordinary characters, not an escape syntax.
 * The iterative wildcard walk avoids regexp backtracking for hostile patterns.
 */
export function matchLike(value: unknown, pattern: string, insensitive: boolean): boolean {
    if (typeof value !== "string") return false;
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
            i = ++restart;
            p = star + 1;
        } else return false;
    }
    while (search[p] === "%") p++;
    return p === search.length;
}
export const caseInsensitiveIndex = (name: string): string => `\0${name}`;
function readPath(value: unknown, path: readonly string[]): unknown {
    for (const part of path) {
        if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
        value = Reflect.get(value, part);
    }
    return value;
}
/** Value of a validated filter operand: a row field, a literal or a field's length. */
function operandValue(row: unknown, expression: Expression): unknown {
    switch (expression.kind) {
        case "getAt":
            return readPath(row, expression.value.path);
        case "literal":
            return expression.value.value;
        case "length": {
            // TanStack DB also counts a missing (or non-list) value as empty.
            const value = operandValue(row, expression.value.expression);
            return typeof value === "string" || Array.isArray(value) ? value.length : 0;
        }
        default:
            throw new Error(`Storage filters do not support ${expression.kind} operands.`);
    }
}
export function matches(value: unknown, filter?: Filter): boolean {
    if (!filter) return true;
    switch (filter.kind) {
        case "and":
            return filter.value.expressions.every((p) => matches(value, p));
        case "or":
            return filter.value.expressions.some((p) => matches(value, p));
        case "not":
            return !matches(value, filter.value.expression);
        case "like":
        case "ilike": {
            const pattern = operandValue(value, filter.value.right);
            return (
                typeof pattern === "string" &&
                matchLike(operandValue(value, filter.value.left), pattern, filter.kind === "ilike")
            );
        }
        case "in": {
            const values = inValues(filter);
            if (values.length === 0) return false;
            const left = operandValue(value, filter.value.left);
            return values.some((candidate) => compareScalar(left, candidate) === 0);
        }
        case "contains": {
            const array = operandValue(value, filter.value.left);
            const needle = scalarKey(operandValue(value, filter.value.right));
            return (
                Array.isArray(array) &&
                array.some((item) => {
                    try {
                        return scalarKey(item) === needle;
                    } catch {
                        return false;
                    }
                })
            );
        }
        case "eq":
        case "ne":
        case "lt":
        case "lte":
        case "gt":
        case "gte": {
            const left = operandValue(value, filter.value.left);
            const right = operandValue(value, filter.value.right);
            // A missing value is equal only to the same missing value. Checking presence
            // never orders the other side, so it also applies to lists and structs.
            if ((filter.kind === "eq" || filter.kind === "ne") && (left == null || right == null))
                return (left === right) === (filter.kind === "eq");
            const compared = compareScalar(left, right);
            switch (filter.kind) {
                case "eq":
                    return compared === 0;
                case "ne":
                    return compared !== 0;
                case "lt":
                    return compared < 0;
                case "lte":
                    return compared <= 0;
                case "gt":
                    return compared > 0;
                case "gte":
                    return compared >= 0;
            }
        }
        default:
            throw new Error(`Storage filters do not support ${filter.kind} expressions.`);
    }
}
// Validation needs the scalar domain, not its allocated physical index key.
// Keep rich-value parsing and all unsupported-value errors in the shared codec.
function validateScalar(value: unknown): void {
    switch (typeof value) {
        case "undefined":
        case "boolean":
        case "string":
        case "bigint":
            return;
        case "number":
            if (!Number.isFinite(value))
                throw new Error("Only finite numbers and valid dates are queryable.");
            return;
        default:
            if (value !== null) scalarKey(value);
    }
}

/** Admit only the storage subset of spec expressions, with scalar literals. */
export function validateFilter(filter: unknown, depth = 0): asserts filter is Filter {
    if (depth > 256) throw new Error("Storage filter is nested too deeply.");
    const node = filter as { readonly kind?: unknown; readonly value?: Record<string, unknown> } | null;
    if (node === null || typeof node !== "object" || node.value === null || typeof node.value !== "object")
        throw new Error("Storage filters must be expressions.");
    const value = (operand: unknown, allowed: "scalar" | "field" | "string" = "scalar") => {
        const resolved = filterOperand(operand);
        if (!resolved) throw new Error("Storage filter operands are row fields, literals or field lengths.");
        if (allowed === "field" && resolved.kind !== "field")
            throw new Error("Storage membership tests a list field.");
        if (resolved.kind !== "literal") return;
        if (allowed === "string" && typeof resolved.value !== "string")
            throw new Error("LIKE patterns are strings or fields.");
        validateScalar(resolved.value);
    };
    switch (node.kind) {
        case "and":
        case "or":
            if (!Array.isArray(node.value.expressions)) throw new Error("Expected filter operands.");
            for (const child of node.value.expressions) validateFilter(child, depth + 1);
            return;
        case "not":
            return validateFilter(node.value.expression, depth + 1);
        case "eq":
        case "ne":
        case "lt":
        case "lte":
        case "gt":
        case "gte":
            value(node.value.left);
            return value(node.value.right);
        case "in": {
            value(node.value.left);
            const list = filterOperand(node.value.right);
            if (list?.kind !== "literal" || !Array.isArray(list.value))
                throw new Error("Storage membership requires a literal list.");
            return list.value.forEach(validateScalar);
        }
        case "contains":
            value(node.value.left, "field");
            return value(node.value.right);
        case "like":
        case "ilike":
            value(node.value.left);
            return value(node.value.right, "string");
        default:
            throw new Error(`Storage filters do not support ${String(node.kind)} expressions.`);
    }
}
export function validateQuery(query: Query): void {
    validateQueryShape(query);
    if (query.where !== undefined) validateFilter(query.where);
    if (query.after) {
        const key = query.after.key;
        if (typeof key !== "string" && typeof key !== "number")
            throw new Error("Row keys must be strings or finite numbers.");
        validateScalar(key);
        for (const value of query.after.values) validateScalar(value);
    }
    for (const value of [query.offset, query.limit]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
            throw new Error("Limit and offset must be nonnegative safe integers.");
    }
    if (query.after && query.after.values.length !== (query.orderBy?.length ?? 0))
        throw new Error("Cursor must include one value for every ordering field.");
}
function compareCursors(left: Cursor, right: Cursor, query: Query): number {
    for (let i = 0; i < (query.orderBy?.length ?? 0); i++) {
        const nulls = query.orderBy![i]!.nulls;
        if (nulls && (left.values[i] == null || right.values[i] == null)) {
            if (left.values[i] == null && right.values[i] == null) continue;
            return (left.values[i] == null ? -1 : 1) * (nulls === "first" ? 1 : -1);
        }
        const cmp = compareScalar(left.values[i], right.values[i]);
        if (cmp) return query.orderBy![i]!.direction === "desc" ? -cmp : cmp;
    }
    return compareScalar(left.key, right.key);
}
export const cursorOf = <A>(row: Row<A>, query: Query): Cursor => ({
    key: row.key,
    values: (query.orderBy ?? []).map((order) => readField(row.value, order.field) as Scalar),
});
export const compareRows = <A>(a: Row<A>, b: Row<A>, query: Query): number =>
    compareCursors(cursorOf(a, query), cursorOf(b, query), query);
export const afterCursor = <A>(row: Row<A>, query: Query): boolean =>
    !query.after || compareCursors(cursorOf(row, query), query.after, query) > 0;
export function applyQuery<A>(rows: readonly Row<A>[], query: Query = {}): Row<A>[] {
    validateQuery(query);
    return rows
        .filter((row) => matches(row.value, query.where) && afterCursor(row, query))
        .sort((a, b) => compareRows(a, b, query))
        .slice(query.offset ?? 0, query.limit === undefined ? undefined : (query.offset ?? 0) + query.limit);
}

/** Normalize only a field/literal comparison for candidate lookup; never reinterpret literals. */
export function indexedComparison(filter: Filter):
    | {
          readonly op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
          readonly field: Field;
          readonly value: Scalar;
      }
    | undefined {
    if (!["eq", "ne", "lt", "lte", "gt", "gte"].includes(filter.kind)) return undefined;
    const comparison = filter as Extract<Filter, { kind: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" }>;
    const left = filterOperand(comparison.value.left);
    const right = filterOperand(comparison.value.right);
    if (left?.kind === "field" && right?.kind === "literal")
        return { op: comparison.kind, field: left.field, value: right.value as Scalar };
    if (right?.kind === "field" && left?.kind === "literal") {
        const reversed = { eq: "eq", ne: "ne", lt: "gt", lte: "gte", gt: "lt", gte: "lte" } as const;
        return { op: reversed[comparison.kind], field: right.field, value: left.value as Scalar };
    }
    return undefined;
}
