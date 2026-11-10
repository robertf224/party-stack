import { o } from "@party-stack/ontology-spec";
import type { Expression, QueryDocument, QuerySelection } from "@party-stack/ontology-spec";
import type { Operand, Predicate, Query as Scan } from "@party-stack/ontology-storage";

/** Physical scans currently have total scalar ordering, whereas logical ordered
 * comparisons require compatible, present operands. Until that boundary is
 * unified, only translate predicates with identical semantics in both models.
 */
function restriction(predicate: Predicate, binding: string): { expression?: Expression; exact: boolean } {
    const operand = (value: Operand): Expression =>
        value !== null && typeof value === "object" && "_tag" in value && value._tag === "Field"
            ? o.Expression.getAt({
                  source: o.Expression.localReference({ name: binding }),
                  path: [...value.path],
              })
            : o.Expression.literal({ value });
    if (predicate.op === "and" || predicate.op === "or") {
        const children = predicate.predicates.map((p) => restriction(p, binding));
        if (predicate.op === "or" && children.some((p) => !p.exact)) return { exact: false };
        return {
            expression: o.Expression[predicate.op]({
                expressions: children.flatMap((p) => (p.expression ? [p.expression] : [])),
            }),
            exact: children.every((p) => p.exact),
        };
    }
    if (predicate.op === "not") {
        const child = restriction(predicate.predicate, binding);
        return child.exact && child.expression
            ? { expression: o.Expression.not({ expression: child.expression }), exact: true }
            : { exact: false };
    }
    if (predicate.op === "in")
        return {
            expression: o.Expression.in({
                left: operand(predicate.left),
                right: o.Expression.literal({ value: predicate.values }),
            }),
            exact: true,
        };
    if (["eq", "ne", "contains", "like", "ilike"].includes(predicate.op))
        return {
            expression: o.Expression[predicate.op as "eq" | "ne" | "contains" | "like" | "ilike"]({
                left: operand(predicate.left),
                right: operand(predicate.right),
            }),
            exact: true,
        };
    return { exact: false };
}

/** One independently narrowed path per grant site. Narrowing an ancestor of the
 * same type must not remove a different grant reached through its descendants.
 * Windows and singular cardinality are semantic barriers, not planner hints.
 */
export function authorizationPlans(document: QueryDocument, objectType: string, scan: Scan): QueryDocument[] {
    const paths = (items: readonly QuerySelection[]): QuerySelection[][] =>
        items.flatMap((item): QuerySelection[][] => {
            if (item.kind === "field") return [];
            if (item.kind === "selectCase") {
                const result: QuerySelection[][] = [];
                for (const [index, branch] of item.value.branches.entries()) {
                    for (const path of paths(branch.select))
                        result.push([
                            {
                                ...item,
                                value: {
                                    ...item.value,
                                    branches: item.value.branches.map((b, i) => ({
                                        ...b,
                                        select: i === index ? path : [],
                                    })),
                                    else: [],
                                },
                            },
                        ]);
                }
                for (const path of paths(item.value.else ?? []))
                    result.push([
                        {
                            ...item,
                            value: {
                                ...item.value,
                                branches: item.value.branches.map((b) => ({ ...b, select: [] })),
                                else: path,
                            },
                        },
                    ]);
                return result;
            }
            const query = item.value.query;
            if (query.from.source.ontology) return [];
            const result: QuerySelection[][] = [];
            if (query.from.source.objectType === objectType) {
                const where =
                    scan.where && !query.page && item.value.cardinality !== "one"
                        ? restriction(scan.where, query.from.binding).expression
                        : undefined;
                result.push([
                    {
                        ...item,
                        value: {
                            ...item.value,
                            query: {
                                ...query,
                                where: where
                                    ? query.where
                                        ? o.Expression.and({ expressions: [query.where, where] })
                                        : where
                                    : query.where,
                            },
                        },
                    },
                ]);
            }
            for (const path of paths(query.select))
                result.push([
                    {
                        ...item,
                        value: { ...item.value, query: { ...query, select: path } },
                    },
                ]);
            return result;
        });
    return paths(document.select).map((select) => ({ ...document, select }));
}
