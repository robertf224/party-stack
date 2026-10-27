import { evaluateQuery } from "@party-stack/ontology-storage";
import { loadBaseline, loadVisible } from "@party-stack/ontology-storage/overlay";
import { Effect } from "effect";
import type { Key, Query, Row } from "@party-stack/ontology-storage";
import type { Overlay } from "@party-stack/ontology-storage/overlay";
import type { ReadTransaction } from "@party-stack/ontology-storage/tables";

/** Offset rows influence a window even though they are not returned. */
export function retentionQuery(query: Query = {}): Query {
    // Forward unchanged demands unchanged. Only an offset needs a wider prefix;
    // adding a redundant offset:0 would split demand/coverage/diagnostic identity.
    if (!query.offset) return query;
    return {
        ...query,
        offset: 0,
        limit:
            query.limit === undefined ? undefined : query.limit === 0 ? 0 : (query.offset ?? 0) + query.limit,
    };
}

/** Unbounded predicates are checked per sweep candidate, without loading the
 * entire matching region. Bounded windows use the storage query planner.
 */
export const markQuery = Effect.fnUntraced(function* (
    tx: ReadTransaction,
    view: Overlay<Record<string, unknown>>,
    query: Query = {}
) {
    const prefix = retentionQuery(query);
    if (prefix.limit === undefined)
        return (
            base: Row<Record<string, unknown>>,
            visible: Row<Record<string, unknown>> | undefined,
            baseline?: Row<Record<string, unknown>>
        ) =>
            evaluateQuery([base], prefix).length > 0 ||
            (baseline !== undefined && evaluateQuery([baseline], prefix).length > 0) ||
            (visible !== undefined && evaluateQuery([visible], prefix).length > 0);
    const keys = new Set<Key>();
    for (const row of yield* tx.loadSubset(view.base, prefix)) keys.add(row.key);
    for (const row of yield* loadBaseline(tx, view, prefix)) keys.add(row.key);
    for (const row of yield* loadVisible(tx, view, prefix)) keys.add(row.key);
    return (base: Row<Record<string, unknown>>) => keys.has(base.key);
});

export function affectsCoverage(row: Row<Record<string, unknown>>, query: Query = {}): boolean {
    return (
        evaluateQuery([row], { where: query.where, orderBy: query.orderBy, after: query.after }).length > 0
    );
}
