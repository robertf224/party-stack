import { BackendError } from "@party-stack/ontology-backend";
import { CurrentExecutionContext } from "@party-stack/ontology-backend/policy";
import { makeStorageBackend } from "@party-stack/ontology-backend/storage";
import { Effect } from "effect";
import { executeTransactionMutator, withTransactionCollections } from "../runtime/transactions.js";
import { createReadTx } from "./mutators/createReadTx.js";
import type { OntologyMutatorRegistry, OntologyQueryFunctionRegistry } from "./mutators/types.js";
import type { StorageBackendOptions } from "@party-stack/ontology-backend/storage";
export interface StorageOntologyBackendOptions extends Omit<
    StorageBackendOptions,
    "mutators" | "queryFunctions"
> {
    readonly mutators?: OntologyMutatorRegistry;
    readonly queryFunctions?: OntologyQueryFunctionRegistry;
}
const promise = <A>(body: () => Promise<A>) =>
    Effect.tryPromise({
        try: body,
        catch: (cause) =>
            cause instanceof BackendError
                ? cause
                : new BackendError({
                      operation: "queryFunction",
                      kind: "Internal",
                      message: "Query function failed.",
                      retryable: false,
                      cause,
                  }),
    });
/** SDK authoring adapter only; authoritative bytes, encryption and storage stay native. */
export const makeStorageOntologyBackend = Effect.fn("StorageOntology.make")(function* (
    options: StorageOntologyBackendOptions
) {
    return yield* makeStorageBackend({
        ...options,
        mutators: Object.fromEntries(
            options.ir.actionTypes
                .filter((action) => action.logic.length || options.mutators?.[action.name])
                .map((action) => [
                    action.name,
                    (tx, invocation) =>
                        Effect.flatMap(CurrentExecutionContext, (context) =>
                            executeTransactionMutator({
                                ir: options.ir,
                                tx,
                                name: invocation.name,
                                parameters: invocation.parameters,
                                operationId: invocation.id,
                                replay: invocation.replay,
                                context: context ?? options.context,
                                mutators: options.mutators,
                            })
                        ),
                ])
        ),
        queryFunctions: Object.fromEntries(
            Object.entries(options.queryFunctions ?? {}).map(([name, handler]) => [
                name,
                (tx, parameters) =>
                    Effect.flatMap(CurrentExecutionContext, (context) =>
                        withTransactionCollections(options.ir, tx, (objects, ensureLoaded) =>
                            promise(async () =>
                                handler({
                                    tx: createReadTx(objects, ensureLoaded),
                                    args: parameters,
                                    context: context ?? options.context ?? {},
                                })
                            )
                        )
                    ),
            ])
        ),
    });
});
