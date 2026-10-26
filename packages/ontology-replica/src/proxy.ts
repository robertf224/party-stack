import { BackendError } from "@party-stack/ontology-backend";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, RcMap, Scope } from "effect";
import type { ReplicaService } from "./index.js";
import type { BackendSubset, OntologyBackendService } from "@party-stack/ontology-backend";

/** Read cache only: upstream writes never enter this replica's outbox. Each
 * request retains shared demand until it finishes; idle subsets have bounded leases.
 * Bind one instance to a trusted upstream identity, then authorize/project each read.
 */
export const makeCachedProxy = Effect.fn("OntologyProxy.make")(function* (options: {
    readonly replica: ReplicaService;
    readonly backend: OntologyBackendService;
    readonly idleDemandMs?: number;
    readonly maxSubsets?: number;
    readonly eager?: readonly BackendSubset[];
    readonly confirmed?: boolean;
}): Effect.fn.Return<OntologyBackendService, BackendError, Scope.Scope> {
    const idle = options.idleDemandMs ?? 60_000;
    const capacity = options.maxSubsets ?? 1_024;
    if (!Number.isFinite(idle) || idle < 0 || !Number.isSafeInteger(capacity) || capacity < 1)
        return yield* new BackendError({
            operation: "proxy.configure",
            kind: "ValidationFailed",
            message: "Invalid cache demand bounds.",
            retryable: false,
        });
    const codec = Table.make<BackendSubset>({ name: "proxy-subset" });
    const demands = yield* RcMap.make({
        lookup: (key: string) => options.replica.demand(codec.decode(key)),
        capacity,
        idleTimeToLive: idle,
    });
    for (const subset of options.eager ?? []) yield* options.replica.demand(subset);
    if (options.eager?.length) yield* options.replica.syncOnce;
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
        loadSubset: Effect.fn("OntologyProxy.loadSubset")((subset) =>
            Effect.scoped(
                Effect.gen(function* () {
                    yield* RcMap.get(demands, codec.encode({ ...subset, query: subset.query ?? {} })).pipe(
                        Effect.catchTag("ExceededCapacityError", () =>
                            Effect.fail(
                                new BackendError({
                                    operation: "proxy.loadSubset",
                                    kind: "RateLimited",
                                    message: "Cache demand capacity reached.",
                                    retryable: true,
                                    invocationOutcome: "not-committed",
                                })
                            )
                        )
                    );
                    // syncOnce coordinates with the replica's existing loop and repairs demand
                    // before serving. Reads use confirmed rows, never a proxy prediction.
                    yield* repairInvalidation();
                    yield* options.replica.syncOnce;
                    return yield* options.replica.snapshotSubset(
                        { ...subset, query: subset.query ?? {} },
                        options.confirmed ?? true
                    );
                })
            )
        ),
        invoke: Effect.fn("OntologyProxy.invoke")(function* (invocation) {
            const receipt = yield* options.backend.invoke(invocation);
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
            yield* repairInvalidation().pipe(Effect.catch(() => Effect.void));
            return receipt;
        }),
    };
});
