import { BackendError } from "@party-stack/ontology-backend";
import { queryExecutor } from "@party-stack/ontology-backend/query";
import { Effect } from "effect";
import type { Expression, OntologyIR } from "@party-stack/ontology-spec";

/** A deliberately small proof language. Unknown expressions fall back to the
 * ordinary policy read; never evaluate an absent row field as undefined.
 */
function keyAndContextOnly(expression: Expression, binding: string, primaryKey: string): boolean {
    switch (expression.kind) {
        case "literal":
        case "contextReference":
            return true;
        case "getAt":
            return expression.value.source.kind === "localReference"
                ? expression.value.source.value.name === binding &&
                      expression.value.path.length === 1 &&
                      expression.value.path[0] === primaryKey
                : keyAndContextOnly(expression.value.source, binding, primaryKey);
        case "eq":
        case "ne":
        case "in":
            return (
                keyAndContextOnly(expression.value.left, binding, primaryKey) &&
                keyAndContextOnly(expression.value.right, binding, primaryKey)
            );
        case "and":
        case "or":
            return expression.value.expressions.every((e) => keyAndContextOnly(e, binding, primaryKey));
        case "not":
            return keyAndContextOnly(expression.value.expression, binding, primaryKey);
        default:
            return false;
    }
}

/** Proves visibility of an identity already supplied by a trusted receipt, not
 * existence of an arbitrary object. Thus this also works after deletion. Only
 * unconditional, unwindowed root grants qualify: ancestors, lookups, row fields,
 * singular selections and conditional grants still require a real policy read.
 */
export function receiptPolicyProof(ir: OntologyIR, context: Record<string, unknown>) {
    const grants = (ir.policy?.objects.select ?? []).flatMap((selection) => {
        if (selection.kind !== "sub" || selection.value.cardinality !== "many") return [];
        const query = selection.value.query;
        const object = ir.objectTypes.find((type) => type.name === query.from.source.objectType);
        if (
            !object ||
            query.from.source.ontology ||
            query.page ||
            (query.where && !keyAndContextOnly(query.where, query.from.binding, object.primaryKey))
        )
            return [];
        return [{ query, object }];
    });
    const evaluator = queryExecutor({
        context,
        reader: {
            ir,
            loadSubset: () =>
                Effect.fail(
                    new BackendError({
                        operation: "receipt.policy",
                        kind: "InvalidRequest",
                        message: "Identity proofs cannot read objects.",
                        retryable: false,
                    })
                ),
        },
    });
    return Effect.fnUntraced(function* (objectType: string, key: string | number) {
        for (const { query, object } of grants) {
            if (object.name !== objectType) continue;
            if (!query.where) return true;
            const result = yield* evaluator.evaluate(
                query.where,
                new Map([[query.from.binding, { [object.primaryKey]: key }]])
            );
            if (result.certain && result.value === true) return true;
        }
        return false;
    });
}
