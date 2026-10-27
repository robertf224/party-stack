import { BackendError } from "@party-stack/ontology-backend";
import { Effect } from "effect";
import { resolveActionParameters } from "../live/expression.js";
import { createReadTx } from "../live/mutators/createMutatorTx.js";
import { withTransactionCollections } from "./transactions.js";
import type { OwnedReadTransaction } from "@party-stack/ontology-backend/owned";
import type { OntologyIR } from "@party-stack/ontology-spec";

/** Read-only defaults/prefills. The supplied read view determines authorization and snapshot guarantees. */
export const resolveReadActionParameters = Effect.fn("Ontology.resolveActionParameters")(function* (options: {
    readonly ir: OntologyIR;
    readonly read: OwnedReadTransaction;
    readonly context?: Record<string, unknown>;
    readonly name: string;
    readonly parameters: Record<string, unknown>;
}) {
    if (!options.ir.actionTypes.some((action) => action.name === options.name))
        return yield* new BackendError({
            operation: "resolveActionParameters",
            kind: "NotFound",
            message: "Action is unavailable.",
            retryable: false,
        });
    return yield* withTransactionCollections(options.ir, options.read, (objects, ensureLoaded) =>
        Effect.tryPromise({
            try: () =>
                resolveActionParameters({
                    ir: options.ir,
                    actionTypeName: options.name,
                    initialParameters: options.parameters,
                    context: options.context ?? {},
                    tx: createReadTx(objects, ensureLoaded),
                }),
            catch: (cause) => {
                return cause instanceof BackendError
                    ? cause
                    : new BackendError({
                          operation: "resolveActionParameters",
                          kind: "ValidationFailed",
                          message: "Action parameters could not be resolved.",
                          retryable: false,
                          cause,
                      });
            },
        })
    );
});
