import { filterOperand, inValues } from "@party-stack/ontology-storage/tables";
import type { Filter, FilterOperand } from "@party-stack/ontology-storage";

export interface MetaLookup {
    readonly field: string;
    readonly values: string[];
}

/** Select a bounded superset; the shared query engine applies residual predicates.
 * AND can use one bounded branch. OR must cover every branch with the same lookup.
 */
export function planMetaLookup(
    predicate: Filter | undefined,
    fields: Readonly<Record<string, string>>
): MetaLookup | undefined {
    if (!predicate) return;
    const lookup = (
        operand: FilterOperand | undefined,
        values: readonly string[]
    ): MetaLookup | undefined => {
        if (operand?.kind !== "field") return;
        const path = operand.field.path.join(".");
        if (!Object.hasOwn(fields, path)) return;
        return { field: fields[path]!, values: [...new Set(values)] };
    };
    switch (predicate.kind) {
        case "eq": {
            const left = filterOperand(predicate.value.left);
            const right = filterOperand(predicate.value.right);
            if (right?.kind === "literal" && typeof right.value === "string")
                return lookup(left, [right.value]);
            if (left?.kind === "literal" && typeof left.value === "string")
                return lookup(right, [left.value]);
            return;
        }
        case "in": {
            const values = inValues(predicate);
            if (values.every((value): value is string => typeof value === "string"))
                return lookup(filterOperand(predicate.value.left), values);
            return;
        }
        case "and": {
            const bounded = predicate.value.expressions
                .map((child) => planMetaLookup(child, fields))
                .filter((child) => child !== undefined);
            return bounded.find((child) => child.values.length === 0) ?? bounded[0];
        }
        case "or": {
            const children = predicate.value.expressions.map((child) => planMetaLookup(child, fields));
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
