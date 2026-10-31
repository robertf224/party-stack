import { and } from "@party-stack/ontology-spec/query";
import type { Expression, Query } from "@party-stack/ontology-spec";

interface Property {
    readonly binding: string;
    readonly path: readonly string[];
}
const property = (expression: Expression): Property | undefined =>
    expression.kind === "getAt" && expression.value.source.kind === "localReference"
        ? { binding: expression.value.source.value.name, path: expression.value.path }
        : undefined;

/** Conservative eligibility: residual filters must use only this row, inputs,
 * context and literals. Nested queries/maps and other expressions keep the
 * ordinary execution path rather than guessing their binding dependencies.
 */
function independent(expression: Expression, binding: string): boolean {
    if (
        expression.kind === "literal" ||
        expression.kind === "inputReference" ||
        expression.kind === "contextReference"
    )
        return true;
    if (expression.kind === "localReference") return expression.value.name === binding;
    if (expression.kind === "getAt") return independent(expression.value.source, binding);
    if (expression.kind === "and" || expression.kind === "or")
        return expression.value.expressions.every((value) => independent(value, binding));
    if (expression.kind === "not") return independent(expression.value.expression, binding);
    if ("left" in expression.value && "right" in expression.value)
        return independent(expression.value.left, binding) && independent(expression.value.right, binding);
    return false;
}

export function batchCorrelation(query: Query) {
    if (
        query.page?.limit !== undefined ||
        query.page?.offset !== undefined ||
        query.page?.after !== undefined
    )
        return;
    const terms = (expression: Expression): Expression[] =>
        expression.kind === "and" ? expression.value.expressions.flatMap(terms) : [expression];
    const predicates = query.where ? terms(query.where) : [];
    for (const [index, expression] of predicates.entries()) {
        if (expression.kind !== "eq") continue;
        for (const [child, parent] of [
            [expression.value.left, expression.value.right],
            [expression.value.right, expression.value.left],
        ] as const) {
            const childProperty = property(child);
            const parentProperty = property(parent);
            if (
                !childProperty ||
                childProperty.binding !== query.from.binding ||
                !parentProperty ||
                parentProperty.binding === query.from.binding
            )
                continue;
            const residual = predicates.filter((_, i) => i !== index);
            if (!residual.every((value) => independent(value, query.from.binding))) continue;
            return {
                path: childProperty.path,
                parent,
                residual: residual.length ? and(...residual) : undefined,
            };
        }
    }
}
