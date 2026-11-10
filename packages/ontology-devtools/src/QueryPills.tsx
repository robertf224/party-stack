import { subsetQuery } from "./queryIR.js";
import { operandText } from "./QueryTokens.js";
import { QueryView } from "./QueryView.js";
import type { Demand, Load } from "./diagnostics.js";
import type { ObjectTypeDef } from "@party-stack/ontology";

export { operandText, nullOrderLabel, OperandToken, QuerySubject } from "./QueryTokens.js";
type Query = NonNullable<Demand["query"]>;
type Predicate = NonNullable<Query["where"]>;
const operators = {
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

export function predicateText(predicate: Predicate, object?: ObjectTypeDef): string {
    if (predicate.op === "and" || predicate.op === "or")
        return predicate.predicates.length
            ? `(${predicate.predicates.map((item) => predicateText(item, object)).join(predicate.op === "and" ? " AND " : " OR ")})`
            : predicate.op === "and"
              ? "All rows"
              : "No rows";
    if (predicate.op === "not") return `NOT (${predicateText(predicate.predicate, object)})`;
    if (predicate.op === "in")
        return `${operandText(predicate.left, object)} in [${predicate.values.map((value) => operandText(value)).join(", ")}]`;
    if (
        (predicate.op === "eq" || predicate.op === "ne") &&
        (predicate.right === null || predicate.right === undefined)
    )
        return `${operandText(predicate.left, object)} is${predicate.op === "ne" ? " not" : ""} ${operandText(predicate.right)}`;
    return `${operandText(predicate.left, object)} ${operators[predicate.op]} ${operandText(predicate.right, object)}`;
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
