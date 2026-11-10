import { isField } from "@party-stack/ontology-storage/tables";
import type { Operand, Predicate } from "@party-stack/ontology-storage";

export interface MetaLookup {
    readonly field: string;
    readonly values: string[];
}

/** Select a bounded superset; the shared query engine applies residual predicates.
 * AND can use one bounded branch. OR must cover every branch with the same lookup.
 */
export function planMetaLookup(
    predicate: Predicate | undefined,
    fields: Readonly<Record<string, string>>
): MetaLookup | undefined {
    if (!predicate) return;
    const lookup = (operand: Operand, values: readonly string[]): MetaLookup | undefined => {
        if (!isField(operand)) return;
        const path = operand.path.join(".");
        if (!Object.hasOwn(fields, path)) return;
        return { field: fields[path]!, values: [...new Set(values)] };
    };
    switch (predicate.op) {
        case "eq":
            if (typeof predicate.right === "string") return lookup(predicate.left, [predicate.right]);
            if (typeof predicate.left === "string") return lookup(predicate.right, [predicate.left]);
            return;
        case "in":
            if (predicate.values.every((value): value is string => typeof value === "string"))
                return lookup(predicate.left, predicate.values);
            return;
        case "and": {
            const bounded = predicate.predicates
                .map((child) => planMetaLookup(child, fields))
                .filter((child) => child !== undefined);
            return bounded.find((child) => child.values.length === 0) ?? bounded[0];
        }
        case "or": {
            const children = predicate.predicates.map((child) => planMetaLookup(child, fields));
            const first = children[0];
            if (!first || children.some((child) => child?.field !== first.field)) return;
            return {
                field: first.field,
                values: [...new Set(children.flatMap((child) => child!.values))],
            };
        }
        default:
            return;
    }
}
