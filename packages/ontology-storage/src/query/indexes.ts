import { validateField } from "../ontology/fields.js";
import { filterOperand } from "./filter.js";
import type { Field, Index, Query, Filter } from "../model.js";
import type { ObjectTypeDef, OntologyIR } from "@party-stack/ontology-spec";

/** Lazy query indexes are bounded by declared top-level properties, not query literals or
 * dynamic paths, and fit each property's type: a scalar property gets a scalar index, a
 * scalar list an element index for `contains`, and any list a size index for its
 * missing-value and `length` checks. No scalar index is requested for a list or struct. */
export function indexesForQuery(query: Query, ir: OntologyIR, object: ObjectTypeDef): readonly Index[] {
    const indexes = new Map<string, Index>();
    const store = { name: object.name, definition: object };
    const fits = (field: Field, mode: boolean | "list") => {
        if (field.path.length !== 1 || !object.properties.some((property) => property.name === field.path[0]))
            return false;
        try {
            validateField(ir, store, field, mode);
            return true;
        } catch {
            return false;
        }
    };
    const add = (field: Field, kind: "scalar" | "elements" | "size") => {
        if (!fits(field, kind === "scalar" ? false : kind === "elements" ? true : "list")) return false;
        const name = `query:${kind}:${JSON.stringify(field.path)}`;
        indexes.set(name, {
            name,
            field,
            ...(kind === "elements" ? { multiEntry: true } : kind === "size" ? { size: true } : {}),
        });
        return true;
    };
    const visit = (p: Filter): void => {
        if (p.kind === "and" || p.kind === "or") return p.value.expressions.forEach(visit);
        if (p.kind === "not") return visit(p.value.expression);
        if (!("left" in p.value)) return;
        const left = filterOperand(p.value.left);
        const right = filterOperand(p.value.right);
        const missing = (operand: typeof left) => operand?.kind === "literal" && operand.value == null;
        const presence = (p.kind === "eq" || p.kind === "ne") && (missing(left) || missing(right));
        for (const [operand, index] of [
            [left, 0],
            [right, 1],
        ] as const) {
            // A list's length and missing-value checks use its size index; a scalar's
            // missing value is an ordinary key of its scalar index.
            if (operand?.kind === "length") add(operand.field, "size");
            else if (operand?.kind === "field")
                if (index === 0 && p.kind === "contains") add(operand.field, "elements");
                else if (!add(operand.field, "scalar") && presence) add(operand.field, "size");
        }
    };
    if (query.where) visit(query.where);
    query.orderBy?.forEach((order) => add(order.field, "scalar"));
    return [...indexes.values()];
}
