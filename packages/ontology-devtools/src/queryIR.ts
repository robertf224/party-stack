import type { Demand } from "./diagnostics.js";
import type { QueryOperand } from "./QueryTokens.js";
import type { Expression, Query } from "@party-stack/ontology";

type Subset = NonNullable<Demand["query"]>;
type Predicate = NonNullable<Subset["where"]>;
const literal = (value: unknown): Expression => ({ kind: "literal", value: { value } });

function operand(value: QueryOperand): Expression {
    return value !== null && typeof value === "object" && "_tag" in value && value._tag === "Field"
        ? {
              kind: "getAt",
              value: { source: { kind: "localReference", value: { name: "row" } }, path: [...value.path] },
          }
        : literal(value);
}

function predicate(value: Predicate): Expression {
    if (value.op === "and" || value.op === "or")
        return { kind: value.op, value: { expressions: value.predicates.map(predicate) } };
    if (value.op === "not") return { kind: "not", value: { expression: predicate(value.predicate) } };
    if (value.op === "in")
        return { kind: "in", value: { left: operand(value.left), right: literal(value.values) } };
    return { kind: value.op, value: { left: operand(value.left), right: operand(value.right) } };
}

/** One renderer for portable query graphs and the engine's compiled subsets. */
export function subsetQuery(objectType: string, subset?: Subset): Query {
    return {
        from: { source: { objectType }, binding: "row" },
        where: subset?.where && predicate(subset.where),
        orderBy: subset?.orderBy?.map((order) => ({
            expression: operand(order.field),
            direction: order.direction,
            nulls: order.nulls,
        })),
        page: subset && {
            limit: subset.limit,
            offset: subset.offset,
            after: subset.after && { key: subset.after.key, values: [...subset.after.values] },
        },
        select: [],
    };
}
