import { pull } from "@party-stack/ontology-backend/meta";
import { executeQuery } from "@party-stack/ontology-backend/query";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import metaOntology from "@party-stack/ontology-spec/meta";
import { Effect, Exit, Queue, Scope, Stream, SubscriptionRef } from "effect";
import { replicaController } from "./internal.js";
import type { DefinitionSource } from "./follow.js";
import type { ReplicaService } from "./service.js";
import type { BackendError } from "@party-stack/ontology-backend";
import type { DefinitionSelection } from "@party-stack/ontology-backend/meta";
import type { QueryReader } from "@party-stack/ontology-backend/query";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { ObjectSubset } from "@party-stack/ontology-spec/query";

/**
 * Follow the definition a meta replica describes. Each read compiles the definition from the
 * replica's local rows (as `pull` does against a backend) and demands exactly the rows it read,
 * so the metadata stays cached for an offline start and in sync while the replica runs. A change
 * to any row the last read used, or a revalidation, reads it again once all of those rows are
 * current: a sync that refreshes several types (a provider that serves each type's metadata
 * separately) reopens the replica once, under all of them.
 */
export const followMetaReplica = (
    meta: ReplicaService,
    select: DefinitionSelection = {}
): Effect.Effect<DefinitionSource> =>
    Effect.map(SubscriptionRef.make(0), (requests) => {
        const read = Effect.fnUntraced(function* (scope: Scope.Scope) {
            // Any row change after this revision may not be reflected in what is read below.
            const revision = yield* replicaController(meta).readVisibleRevision;
            const subsets: ObjectSubset[] = [];
            const reader: QueryReader = {
                ir: metaOntology,
                loadSubset: (objectType, query) => {
                    const subset = objectSubset(objectType, query);
                    subsets.push(subset);
                    // The replica's own freshness rules apply: a live one serves cached rows while
                    // it refreshes them; a one-shot one reloads rows older than its coverage age.
                    return meta.demand
                        .acquire(subset)
                        .pipe(Scope.provide(scope), Effect.andThen(meta.readSubset(subset)));
                },
            };
            const ir = yield* pull(
                {
                    query: (document, settings) =>
                        executeQuery(document, { reader, inputs: settings?.inputs }).pipe(
                            Effect.map((result) => result.value)
                        ),
                },
                select
            );
            return { ir, revision, subsets };
        });
        const changed = (subset: ObjectSubset, revision: number) => {
            let first = true;
            return meta.observeSubset(subset).pipe(
                Stream.filter((batch) => {
                    const initial = first;
                    first = false;
                    if (batch.revision <= revision) return false;
                    // The first batch is the subset as it is now: newer than the read only if
                    // something changed in between.
                    return initial || batch.reset || batch.rows.length > 0 || batch.removed.length > 0;
                })
            );
        };
        // Every row the definition was read from is current again: a change that arrives in
        // several parts (one type's metadata at a time) is complete before the definition is read.
        // A subset that cannot load now (offline, or failing) does not hold the read back.
        const settled = (subsets: readonly ObjectSubset[]) =>
            Effect.scoped(
                Effect.forEach(subsets, (subset) => meta.demand.acquire(subset, { resultType: "complete" }), {
                    concurrency: "unbounded",
                    discard: true,
                })
            ).pipe(Effect.ignore);
        // Reload every row the definition was read from, then read it again.
        const revalidate = Effect.andThen(
            meta.revalidate,
            SubscriptionRef.update(requests, (count) => count + 1)
        );
        const changes = Stream.callback<OntologyIR, BackendError>((queue) =>
            Effect.gen(function* () {
                // Demand for the rows the last emitted definition was read from.
                let held: Scope.Closeable | undefined;
                yield* Effect.addFinalizer(() => (held ? Scope.close(held, Exit.void) : Effect.void));
                while (true) {
                    const requested = yield* SubscriptionRef.get(requests);
                    const scope = yield* Scope.make();
                    const result = yield* Effect.exit(read(scope));
                    if (Exit.isFailure(result)) {
                        yield* Scope.close(scope, result);
                        return yield* Effect.failCause(result.cause);
                    }
                    const previous = held;
                    held = scope;
                    yield* Queue.offer(queue, result.value.ir);
                    if (previous) yield* Scope.close(previous, Exit.void);
                    const { revision, subsets } = result.value;
                    yield* Stream.mergeAll(
                        [
                            ...subsets.map((subset) => Stream.as(changed(subset, revision), undefined)),
                            SubscriptionRef.changes(requests).pipe(
                                Stream.filter((count) => count !== requested),
                                Stream.as(undefined)
                            ),
                        ],
                        { concurrency: "unbounded" }
                    ).pipe(Stream.runHead);
                    yield* settled(subsets);
                }
            })
        );
        return {
            changes,
            revalidate: () => revalidate,
        } satisfies DefinitionSource;
    });
