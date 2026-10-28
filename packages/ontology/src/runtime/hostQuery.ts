import { evaluateQuery } from "@party-stack/ontology-storage";
import { Effect, Stream } from "effect";
import type { BackendSubset, BackendError } from "@party-stack/ontology-backend";
import type { ReplicaService } from "@party-stack/ontology-replica";
import type { Row } from "@party-stack/ontology-storage";

type QuerySource = Pick<ReplicaService, "observeRows" | "demand" | "retainLocal">;

/** Each observer owns a demand/read lease and composes atomic local row batches. */
export function observeReplicaRows(
    replica: QuerySource,
    subset: BackendSubset,
    options?: { readonly persistedOnly?: boolean }
): Stream.Stream<readonly Row<Record<string, unknown>>[], BackendError> {
    return Stream.unwrap(
        Effect.gen(function* () {
            yield* options?.persistedOnly
                ? replica.retainLocal(subset.objectType, subset.query)
                : replica.demand(subset);
            const rows = new Map<string | number, Row<Record<string, unknown>>>();
            return replica.observeRows(subset.objectType, subset.query).pipe(
                Stream.map((batch) => {
                    if (batch.reset) rows.clear();
                    for (const key of batch.removed) rows.delete(key);
                    for (const row of batch.rows) rows.set(row.key, row);
                    return evaluateQuery([...rows.values()], subset.query ?? {});
                })
            );
        })
    );
}
