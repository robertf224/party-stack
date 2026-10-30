import { executeQuery as execute, queryExecutor as executor } from "@party-stack/ontology-storage/query";
import { Effect } from "effect";
import { BackendError } from "./index.js";
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
