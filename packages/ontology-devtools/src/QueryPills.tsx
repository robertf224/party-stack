import { subsetQuery } from "./queryIR.js";
import { operandText } from "./QueryTokens.js";
import { QueryView } from "./QueryView.js";
import type { Demand, Load } from "./diagnostics.js";
import type { ObjectTypeDef } from "@party-stack/ontology";

export { operandText, nullOrderLabel, OperandToken, QuerySubject } from "./QueryTokens.js";
type Query = NonNullable<Demand["query"]>;
type Predicate = NonNullable<Query["where"]>;
const operators: Record<string, string> = {
    eq: "=",
    ne: "≠",
    lt: "<",
    lte: "≤",
    gt: ">",
    gte: "≥",
    like: "matches",
    ilike: "matches (ignore case)",
    contains: "contains",
};

/** A row field, a field's length or a literal of a compiled storage filter. */
function operand(expression: Predicate, object?: ObjectTypeDef): string {
    if (expression.kind === "literal") return operandText(expression.value.value);
    if (expression.kind === "getAt")
        return operandText({ _tag: "Field", path: expression.value.path }, object);
    if (expression.kind === "length") return `length(${operand(expression.value.expression, object)})`;
    return expression.kind;
}

export function predicateText(predicate: Predicate, object?: ObjectTypeDef): string {
    if (predicate.kind === "and" || predicate.kind === "or")
        return predicate.value.expressions.length
            ? `(${predicate.value.expressions.map((item) => predicateText(item, object)).join(predicate.kind === "and" ? " AND " : " OR ")})`
            : predicate.kind === "and"
              ? "All rows"
              : "No rows";
    if (predicate.kind === "not") return `NOT (${predicateText(predicate.value.expression, object)})`;
    if (!("left" in predicate.value)) return operand(predicate, object);
    const { left, right } = predicate.value;
    if (predicate.kind === "in" && right.kind === "literal" && Array.isArray(right.value.value))
        return `${operand(left, object)} in [${right.value.value.map((value) => operandText(value)).join(", ")}]`;
    if (
        (predicate.kind === "eq" || predicate.kind === "ne") &&
        right.kind === "literal" &&
        right.value.value == null
    )
        return `${operand(left, object)} is${predicate.kind === "ne" ? " not" : ""} ${operand(right)}`;
    return `${operand(left, object)} ${operators[predicate.kind] ?? predicate.kind} ${operand(right, object)}`;
}

/** Compiled demand is a compact view of the same portable query renderer. */
export function QueryPills({
    query,
    object,
    objectType,
    annotations,
}: {
    query?: Query;
    object?: ObjectTypeDef;
    objectType?: string;
    annotations?: NonNullable<Load["pushdown"]>["predicates"];
}) {
    return (
        <QueryView
            query={subsetQuery(objectType ?? object?.name ?? "Object", query)}
            object={object}
            showSubject={Boolean(object || objectType)}
            compact
            annotations={annotations}
        />
    );
}
