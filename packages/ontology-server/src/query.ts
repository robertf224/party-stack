import { BackendError } from "@party-stack/ontology-backend";
import { objectSubset, resolveSubsetSnapshot } from "@party-stack/ontology-backend/subset";
import { Effect } from "effect";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { QueryReader } from "@party-stack/ontology-backend/query";
import type { OntologyIR } from "@party-stack/ontology-spec";

/** Finite query execution cannot interpret an incomplete subset as an absence. */
export const backendQueryReader = (ir: OntologyIR, backend: OntologyBackendService): QueryReader => ({
    ir,
    loadSubset: (objectType, query) =>
        backend.loadSubset(objectSubset(objectType, query)).pipe(
            Effect.flatMap((snapshot) =>
                resolveSubsetSnapshot(ir, objectSubset(objectType, query), snapshot)
            ),
            Effect.map((resolved) => resolved.snapshot),
            Effect.flatMap((snapshot) =>
                snapshot.complete
                    ? Effect.succeed(snapshot.rows)
                    : Effect.fail(
                          new BackendError({
                              operation: "query.read",
                              kind: "InvalidResponse",
                              message: "Query evaluation requires a complete subset snapshot.",
                              retryable: false,
                          })
                      )
            )
        ),
});
