import { Temporal } from "temporal-polyfill";
import { isField, validateQueryShape } from "./schema.js";
import type { Cursor, Field, Key, Operand, Predicate, Query, Row, Scalar } from "../model.js";

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
export function matches(value: unknown, predicate?: Predicate): boolean {
    if (!predicate) return true;
    switch (predicate.op) {
        case "and":
            return predicate.predicates.every((p) => matches(value, p));
        case "or":
            return predicate.predicates.some((p) => matches(value, p));
        case "not":
            return !matches(value, predicate.predicate);
        case "like":
        case "ilike": {
            const pattern = resolveOperand(value, predicate.right);
            return (
                typeof pattern === "string" &&
                matchLike(resolveOperand(value, predicate.left), pattern, predicate.op === "ilike")
            );
        }
        case "in":
            return predicate.values.some(
                (candidate) => compareScalar(resolveOperand(value, predicate.left), candidate) === 0
            );
        case "contains": {
            const array = readField(value, predicate.left);
            const needle = scalarKey(resolveOperand(value, predicate.right));
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
        default: {
            const compared = compareScalar(
                resolveOperand(value, predicate.left),
                resolveOperand(value, predicate.right)
            );
            switch (predicate.op) {
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
    }
}
export function validateQuery(query: Query): void {
    validateQueryShape(query);
    const validateOperand = (operand: Operand) => {
        if (!isField(operand)) scalarKey(operand);
    };
    const validatePredicate = (predicate: Predicate): void => {
        if (predicate.op === "and" || predicate.op === "or") {
            for (const child of predicate.predicates) validatePredicate(child);
        } else if (predicate.op === "not") validatePredicate(predicate.predicate);
        else {
            validateOperand(predicate.left);
            if (predicate.op === "in") for (const value of predicate.values) scalarKey(value);
            else validateOperand(predicate.right);
        }
    };
    if (query.where) validatePredicate(query.where);
    if (query.after) {
        keyCode(query.after.key);
        for (const value of query.after.values) scalarKey(value);
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

export const resolveOperand = (value: unknown, operand: Operand): unknown =>
    isField(operand) ? readField(value, operand) : operand;

/** Normalize only a field/literal comparison for candidate lookup; never reinterpret literals. */
export function indexedComparison(predicate: Predicate):
    | {
          readonly op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
          readonly field: Field;
          readonly value: Scalar;
      }
    | undefined {
    if (
        predicate.op === "and" ||
        predicate.op === "or" ||
        predicate.op === "not" ||
        predicate.op === "in" ||
        predicate.op === "contains" ||
        predicate.op === "like" ||
        predicate.op === "ilike"
    )
        return undefined;
    if (isField(predicate.left) && !isField(predicate.right))
        return { op: predicate.op, field: predicate.left, value: predicate.right };
    if (isField(predicate.right) && !isField(predicate.left)) {
        const reversed = { eq: "eq", ne: "ne", lt: "gt", lte: "gte", gt: "lt", gte: "lte" } as const;
        return { op: reversed[predicate.op], field: predicate.right, value: predicate.left };
    }
    return undefined;
}
