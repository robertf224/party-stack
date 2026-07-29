import { resolveActionParameters } from "../expression.js";
import { createReadTx } from "../mutators/createMutatorTx.js";
import type { OntologyIR } from "../../ir/index.js";
import type {
    LiveOntologyWriteMode,
    LiveOntologyWriteVisibility,
} from "../LiveOntology.js";
import type { OntologyCollection } from "../objects/createLiveOntologyObjectCollection.js";
import type { OntologyObject } from "../objects/OntologyObject.js";
import type { OntologyApplyActionResult } from "../OntologyBackendAdapter.js";
import type { OntologyActionRequest } from "../outbox/types.js";

export interface LiveOntologyActionOptions {
    idempotencyKey?: string;
    mode?: LiveOntologyWriteMode;
    visibility?: LiveOntologyWriteVisibility;
}

export type LiveOntologyAction<
    Parameters extends Record<string, unknown> = Record<
        string,
        unknown
    >,
> = (
    parameters: Parameters,
    options?: LiveOntologyActionOptions
) => Promise<OntologyApplyActionResult | void>;

export function createLiveOntologyAction(options: {
    ir: OntologyIR;
    action: OntologyIR["actionTypes"][number];
    context?: Record<string, unknown>;
    objects: Record<
        string,
        OntologyCollection<OntologyObject>
    >;
    submit(
        request: OntologyActionRequest,
        options?: LiveOntologyActionOptions
    ): Promise<OntologyApplyActionResult | void>;
}): LiveOntologyAction {
    return async (
        providedParameters,
        executionOptions
    ) => {
        const context = options.context ?? {};
        const parameters = await resolveActionParameters({
            ir: options.ir,
            actionTypeName: options.action.name,
            initialParameters: providedParameters,
            context,
            tx: createReadTx(options.objects),
        });
        const idempotencyKey =
            executionOptions?.idempotencyKey ??
            crypto.randomUUID();
        return options.submit(
            {
                actionTypeName: options.action.name,
                parameters,
                idempotencyKey,
            },
            executionOptions
        );
    };
}
