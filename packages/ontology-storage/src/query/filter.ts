import { fieldExpression, rowBinding } from "../model.js";
import type { Field, Filter } from "../model.js";
import type { Expression } from "@party-stack/ontology-spec";

/** One operand of a validated storage filter comparison. */
export type FilterOperand =
    | { readonly kind: "field"; readonly field: Field }
    | { readonly kind: "literal"; readonly value: unknown }
    /** `length` of a list or string field; a missing value has length 0. */
    | { readonly kind: "length"; readonly field: Field };
export type ComparisonKind = "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
export type FilterComparison = Extract<Filter, { kind: ComparisonKind }>;
export type FilterBinary = Extract<Filter, { kind: ComparisonKind | "contains" | "like" | "ilike" | "in" }>;

const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object";

/** The field a filter expression reads directly, if it is a path of the row binding. */
export function filterField(expression: unknown): Field | undefined {
    if (!record(expression) || expression.kind !== "getAt" || !record(expression.value)) return undefined;
    const { source, path } = expression.value;
    return record(source) &&
        source.kind === "localReference" &&
        record(source.value) &&
        source.value.name === rowBinding &&
        Array.isArray(path) &&
        path.length > 0 &&
        path.every((part) => typeof part === "string")
        ? { _tag: "Field", path: path as string[] }
        : undefined;
}

/** Classify one operand position of the storage subset; undefined for anything else. */
export function filterOperand(expression: unknown): FilterOperand | undefined {
    if (!record(expression) || !record(expression.value)) return undefined;
    if (expression.kind === "literal") return { kind: "literal", value: expression.value.value };
    if (expression.kind === "length") {
        const field = filterField(expression.value.expression);
        return field && { kind: "length", field };
    }
    const field = filterField(expression);
    return field && { kind: "field", field };
}

/** The literal list of an `in` filter. */
export const inValues = (expression: Extract<Filter, { kind: "in" }>): readonly unknown[] => {
    const right = filterOperand(expression.value.right);
    if (right?.kind !== "literal" || !Array.isArray(right.value))
        throw new Error("Storage membership requires a literal list.");
    return right.value;
};

/** `length(field) <op> n` as an emptiness test: true when it means "missing or empty",
 * false for "has elements", undefined when it also depends on how many elements there are. */
export function lengthEmptiness(op: ComparisonKind, n: unknown): boolean | undefined {
    if (typeof n !== "number") return undefined;
    if (op === "eq" || op === "ne") return n === 0 ? op === "eq" : undefined;
    if ((op === "lt" && n > 0 && n <= 1) || (op === "lte" && n >= 0 && n < 1)) return true;
    if ((op === "gt" && n >= 0 && n < 1) || (op === "gte" && n > 0 && n <= 1)) return false;
    return undefined;
}

/** A length comparison with the length on the left, or undefined for any other filter. */
export function lengthComparison(
    expression: Filter
): { readonly op: ComparisonKind; readonly field: Field; readonly bound: unknown } | undefined {
    if (!isComparison(expression)) return undefined;
    const flipped = { eq: "eq", ne: "ne", lt: "gt", lte: "gte", gt: "lt", gte: "lte" } as const;
    const left = filterOperand(expression.value.left);
    const right = filterOperand(expression.value.right);
    if (left?.kind === "length" && right?.kind === "literal")
        return { op: expression.kind, field: left.field, bound: right.value };
    if (right?.kind === "length" && left?.kind === "literal")
        return { op: flipped[expression.kind], field: right.field, bound: left.value };
    return undefined;
}

/** The literal values a top-level `eq` or `in` filter allows for one field, if it is one. */
export function fieldValues(
    expression: Filter | undefined,
    path: readonly string[]
): readonly unknown[] | undefined {
    if (expression?.kind !== "eq" && expression?.kind !== "in") return undefined;
    const left = filterOperand(expression.value.left);
    const right = filterOperand(expression.value.right);
    const named = (operand: FilterOperand | undefined) =>
        operand?.kind === "field" &&
        operand.field.path.length === path.length &&
        operand.field.path.every((part, i) => part === path[i]);
    if (expression.kind === "in") return named(left) ? inValues(expression) : undefined;
    if (named(left) && right?.kind === "literal") return [right.value];
    if (named(right) && left?.kind === "literal") return [left.value];
    return undefined;
}

export const isComparison = (expression: Expression): expression is FilterComparison =>
    ["eq", "ne", "lt", "lte", "gt", "gte"].includes(expression.kind);

/** Rebuild a filter's operator tree, replacing each node `replace` handles. */
function rewrite(expression: Expression, replace: (e: Expression) => Expression | undefined): Expression {
    const visit = (e: Expression): Expression => {
        const replaced = replace(e);
        if (replaced) return replaced;
        switch (e.kind) {
            case "getAt":
                return { kind: "getAt", value: { ...e.value, source: visit(e.value.source) } };
            case "and":
            case "or":
                return { kind: e.kind, value: { expressions: e.value.expressions.map(visit) } };
            case "not":
            case "length":
                return { kind: e.kind, value: { expression: visit(e.value.expression) } } as Expression;
            case "eq":
            case "ne":
            case "lt":
            case "lte":
            case "gt":
            case "gte":
            case "in":
            case "contains":
            case "like":
            case "ilike":
                return { kind: e.kind, value: { left: visit(e.value.left), right: visit(e.value.right) } };
            default:
                return e;
        }
    };
    return visit(expression);
}

/** The same filter over another row binding, for embedding in a spec subset. */
export function rebindFilter(expression: Filter, binding: string): Expression {
    if (binding === rowBinding) return expression;
    return rewrite(expression, (e) =>
        e.kind === "localReference" && e.value.name === rowBinding
            ? { kind: "localReference", value: { name: binding } }
            : undefined
    );
}

/** The same filter with each row field path mapped, e.g. through a lens. */
export function mapFilterFields(
    expression: Filter,
    map: (path: readonly string[]) => readonly string[]
): Filter {
    return rewrite(expression, (e) => {
        const read = filterField(e);
        return read && fieldExpression({ _tag: "Field", path: map(read.path) });
    });
}
