import { Effect } from "effect";
import type { ReplicaService } from "./index.js";
import type { BackendError } from "@party-stack/ontology-backend";
import type { BackendSubset, OntologyBackendService } from "@party-stack/ontology-backend";
import type { Scope } from "effect";

/** Read cache only: upstream writes never enter this replica's outbox. Each
 * request acquires the replica's shared demand; the replica config owns idle retention.
 * Bind one instance to a trusted upstream identity, then authorize/project each read.
 */
export const makeCachedProxy = Effect.fn("OntologyProxy.make")(function* (options: {
    readonly replica: ReplicaService;
    readonly backend: OntologyBackendService;
    readonly eager?: readonly BackendSubset[];
    readonly confirmed?: boolean;
}): Effect.fn.Return<OntologyBackendService, BackendError, Scope.Scope> {
    for (const subset of options.eager ?? []) yield* options.replica.demand(subset);
    for (const subset of options.eager ?? []) yield* options.replica.syncSubset(subset);
    let writeGeneration = 0;
    let invalidatedGeneration = 0;
    let dirtyTypes: readonly string[] | undefined = [];
    const repairInvalidation = Effect.fnUntraced(function* () {
        const generation = writeGeneration;
        if (generation <= invalidatedGeneration) return;
        yield* options.replica.invalidate(dirtyTypes);
        invalidatedGeneration = Math.max(invalidatedGeneration, generation);
        if (generation === writeGeneration) dirtyTypes = [];
    });
    return {
        ...options.backend,
        name: `cached:${options.backend.name}`,
        subscribeSelection: options.replica.subscribeSelection,
        acknowledgeDelivery: (position) => options.replica.acknowledgeDelivery(position, false),
        loadSubset: Effect.fn("OntologyProxy.loadSubset")((subset) =>
            Effect.scoped(
                Effect.gen(function* () {
                    yield* options.replica.demand(subset);
                    // Refresh coordinates with the replica's existing loop and repairs demand
                    // before serving. Reads use confirmed rows, never a proxy prediction.
                    yield* repairInvalidation();
                    yield* options.replica.syncSubset(subset);
                    return yield* options.replica.snapshotSubset(
                        { ...subset, query: subset.query ?? {} },
                        options.confirmed ?? true
                    );
                })
            )
        ),
        applyAction: Effect.fn("OntologyProxy.applyAction")(function* (invocation) {
            const receipt = yield* options.backend.applyAction(invocation);
            const affected =
                receipt.affectedComplete === false || receipt.affected === undefined
                    ? undefined
                    : receipt.affected.map((target) => target.objectType);
            dirtyTypes =
                affected === undefined || dirtyTypes === undefined
                    ? undefined
                    : [...new Set([...dirtyTypes, ...affected])];
            writeGeneration++;
            // Preserve the successful outcome even if cache IO fails. A dirty generation
            // forces the next read to retry invalidation before serving retained coverage.
            yield* repairInvalidation().pipe(
                Effect.catch((error) => Effect.logWarning("Proxy cache repair failed", { kind: error.kind }))
            );
            return receipt;
        }),
    };
});
