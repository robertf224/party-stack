import { isField } from "./schema.js";
import type { Index, Query, Predicate } from "../model.js";

/** Lazy query indexes are bounded by declared top-level properties, not query literals or dynamic paths. */
export function indexesForQuery(query: Query, properties: ReadonlySet<string>): readonly Index[] {
    const indexes = new Map<string, Index>();
    const add = (field: Index["field"], multiEntry = false) => {
        if (field.path.length !== 1 || !properties.has(field.path[0]!)) return;
        const name = `query:${multiEntry ? "elements" : "scalar"}:${JSON.stringify(field.path)}`;
        indexes.set(name, { name, field, ...(multiEntry ? { multiEntry: true } : {}) });
    };
    const visit = (p: Predicate): void => {
        if (p.op === "and" || p.op === "or") return p.predicates.forEach(visit);
        if (p.op === "not") return visit(p.predicate);
        if (isField(p.left)) add(p.left, p.op === "contains");
        if ("right" in p && isField(p.right)) add(p.right);
    };
    if (query.where) visit(query.where);
    query.orderBy?.forEach((order) => add(order.field));
    return [...indexes.values()];
}
