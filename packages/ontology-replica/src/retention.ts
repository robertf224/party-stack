import { evaluateQuery } from "@party-stack/ontology-storage";
import { loadVisible } from "@party-stack/ontology-storage/overlay";
import { Effect } from "effect";
import type { Key, Query, Row } from "@party-stack/ontology-storage";
import type { Overlay } from "@party-stack/ontology-storage/overlay";
import type { ReadTransaction } from "@party-stack/ontology-storage/tables";

/** Offset rows influence a window even though they are not returned. */
export function retentionQuery(query: Query = {}): Query {
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
        return (base: Row<Record<string, unknown>>, visible: Row<Record<string, unknown>> | undefined) =>
            evaluateQuery([base], prefix).length > 0 ||
            (visible !== undefined && evaluateQuery([visible], prefix).length > 0);
    const keys = new Set<Key>();
    for (const row of yield* tx.loadSubset(view.base, prefix)) keys.add(row.key);
    for (const row of yield* loadVisible(tx, view, prefix)) keys.add(row.key);
    return (base: Row<Record<string, unknown>>) => keys.has(base.key);
});

export function affectsCoverage(row: Row<Record<string, unknown>>, query: Query = {}): boolean {
    return (
        evaluateQuery([row], { where: query.where, orderBy: query.orderBy, after: query.after }).length > 0
    );
}
