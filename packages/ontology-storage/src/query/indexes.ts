import { filterOperand } from "./filter.js";
import type { Index, Query, Filter } from "../model.js";

/** Lazy query indexes are bounded by declared top-level properties, not query literals or dynamic paths. */
export function indexesForQuery(query: Query, properties: ReadonlySet<string>): readonly Index[] {
    const indexes = new Map<string, Index>();
    const add = (field: Index["field"], multiEntry = false) => {
        if (field.path.length !== 1 || !properties.has(field.path[0]!)) return;
        const name = `query:${multiEntry ? "elements" : "scalar"}:${JSON.stringify(field.path)}`;
        indexes.set(name, { name, field, ...(multiEntry ? { multiEntry: true } : {}) });
    };
    const visit = (p: Filter): void => {
        if (p.kind === "and" || p.kind === "or") return p.value.expressions.forEach(visit);
        if (p.kind === "not") return visit(p.value.expression);
        if (!("left" in p.value)) return;
        // A field's length is evaluated on rows; no scalar index records it.
        const left = filterOperand(p.value.left);
        const right = filterOperand(p.value.right);
        // A presence check may name a list or struct field, which no scalar index can hold.
        const missing = (operand: typeof left) => operand?.kind === "literal" && operand.value == null;
        if ((p.kind === "eq" || p.kind === "ne") && (missing(left) || missing(right))) return;
        if (left?.kind === "field") add(left.field, p.kind === "contains");
        if (right?.kind === "field") add(right.field);
    };
    if (query.where) visit(query.where);
    query.orderBy?.forEach((order) => add(order.field));
    return [...indexes.values()];
}
