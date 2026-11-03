import { executeQuery as execute, queryExecutor as executor } from "@party-stack/ontology-storage/query";
import { Effect } from "effect";
import { objectSubset, resolveSubsetSnapshot } from "./subset.js";
import { BackendError } from "./index.js";
import type { OntologyBackendService } from "./index.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { QueryDocument } from "@party-stack/ontology-spec";
import type {
    QueryReader as Reader,
    QueryExecutionOptions as ExecutionOptions,
    QueryFailure,
} from "@party-stack/ontology-storage/query";

export type { QueryEntity } from "@party-stack/ontology-storage/query";
export type QueryReader = Reader<BackendError>;
export type QueryExecutionOptions = Omit<ExecutionOptions<BackendError>, "error">;
const error = (failure: QueryFailure) =>
    new BackendError({
        operation: "query",
        ...failure,
        retryable: false,
    });

/** Backend boundary for the shared storage query engine, including authorized readers. */
export function queryExecutor(options: QueryExecutionOptions) {
    return executor({ ...options, error });
}
export const executeQuery = Effect.fn("Backend.query")(function* (
    document: QueryDocument,
    options: QueryExecutionOptions
) {
    return yield* execute(document, { ...options, error });
});

/** Finite query execution cannot interpret an incomplete subset as an absence. */
export const backendQueryReader = (
    ir: OntologyIR,
    backend: Pick<OntologyBackendService, "loadSubset">
): QueryReader => ({
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
