import type { Demand } from "./diagnostics.js";
import type { Expression, Query } from "@party-stack/ontology";

type Subset = NonNullable<Demand["query"]>;
type Field = NonNullable<Subset["orderBy"]>[number]["field"];

const fieldExpression = (field: Field): Expression => ({
    kind: "getAt",
    value: { source: { kind: "localReference", value: { name: "row" } }, path: [...field.path] },
});

/** One renderer for portable query graphs and the engine's compiled subsets. Compiled
 * filters are already query expressions over the `row` binding. */
export function subsetQuery(objectType: string, subset?: Subset): Query {
    return {
        from: { source: { objectType }, binding: "row" },
        where: subset?.where,
        orderBy: subset?.orderBy?.map((order) => ({
            expression: fieldExpression(order.field),
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
