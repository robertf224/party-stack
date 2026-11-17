import { o } from "@party-stack/ontology-spec";
import { filterOperand, isComparison, rebindFilter } from "@party-stack/ontology-storage";
import type { Expression, QueryDocument, QuerySelection } from "@party-stack/ontology-spec";
import type { Filter, Query as Scan } from "@party-stack/ontology-storage";

/** Physical scans order every value, whereas logical ordered comparisons require
 * compatible, present operands. Keep only filter terms with identical semantics in
 * both models: ordered comparisons qualify only between lengths and numbers.
 */
function restriction(filter: Filter): { expression?: Filter; exact: boolean } {
    if (filter.kind === "and" || filter.kind === "or") {
        const children = filter.value.expressions.map(restriction);
        if (filter.kind === "or" && children.some((p) => !p.exact)) return { exact: false };
        return {
            expression: o.Expression[filter.kind]({
                expressions: children.flatMap((p) => (p.expression ? [p.expression] : [])),
            }),
            exact: children.every((p) => p.exact),
        };
    }
    if (filter.kind === "not") {
        const child = restriction(filter.value.expression);
        return child.exact && child.expression
            ? { expression: o.Expression.not({ expression: child.expression }), exact: true }
            : { exact: false };
    }
    if (isComparison(filter) && filter.kind !== "eq" && filter.kind !== "ne") {
        const counted = [filter.value.left, filter.value.right].every((e) => {
            const operand = filterOperand(e);
            return (
                operand?.kind === "length" ||
                (operand?.kind === "literal" && typeof operand.value === "number")
            );
        });
        return counted ? { expression: filter, exact: true } : { exact: false };
    }
    return { expression: filter, exact: true };
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
                const restricted =
                    scan.where && !query.page && item.value.cardinality !== "one"
                        ? restriction(scan.where).expression
                        : undefined;
                result.push([
                    {
                        ...item,
                        value: {
                            ...item.value,
                            query: {
                                ...query,
                                where: restricted
                                    ? query.where
                                        ? o.Expression.and({
                                              expressions: [
                                                  query.where,
                                                  rebindFilter(restricted, query.from.binding),
                                              ],
                                          })
                                        : rebindFilter(restricted, query.from.binding)
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
