import { actionExpressions } from "@party-stack/ontology-backend/actions";
import { Effect } from "effect";
import type { OwnedReadTransaction } from "@party-stack/ontology-backend/owned";
import type { OntologyIR } from "@party-stack/ontology-spec";
/** The caller supplies an authorized, transaction-consistent read view. */
export const resolveReadActionParameters = Effect.fn("Ontology.resolveActionParameters")(function* (options: {
    readonly ir: OntologyIR;
    readonly read: OwnedReadTransaction;
    readonly context?: Record<string, unknown>;
    readonly name: string;
    readonly parameters: Record<string, unknown>;
}) {
    return yield* actionExpressions({
        ir: options.ir,
        tx: options.read,
        request: { id: "resolve", name: options.name, parameters: options.parameters },
        context: options.context,
    }).resolve;
});
