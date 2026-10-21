import { Effect, Stream } from "effect";
import type { BackendSubset, BackendError } from "@party-stack/ontology-backend";
import type { ReplicaService } from "@party-stack/ontology-replica";
import type { Row } from "@party-stack/ontology-storage";

type QuerySource = Pick<ReplicaService, "subscribeChanges" | "loadSubset" | "demand" | "retainLocal">;

/** Each stream subscription owns its demand/read lease; notifications may coalesce because reads are snapshots. */
export function observeReplicaRows(
    replica: QuerySource,
    subset: BackendSubset,
    options?: { readonly persistedOnly?: boolean }
): Stream.Stream<readonly Row<Record<string, unknown>>[], BackendError> {
    return Stream.unwrap(
        Effect.gen(function* () {
            // Subscribe before acquiring demand or reading the initial snapshot. A
            // commit racing that read remains queued and causes another snapshot.
            const changes = yield* replica.subscribeChanges;
            const changed = yield* Stream.toPull(changes);
            yield* options?.persistedOnly
                ? replica.retainLocal(subset.objectType, subset.query)
                : replica.demand(subset);
            const read = replica.loadSubset(subset.objectType, subset.query);
            return Stream.concat(
                Stream.fromEffect(read),
                Stream.fromEffectRepeat(changed.pipe(Effect.andThen(read)))
            );
        })
    );
}
