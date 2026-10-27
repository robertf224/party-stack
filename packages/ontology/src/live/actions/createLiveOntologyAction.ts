import { resolveActionParameters } from "../expression.js";
import { createReadTx } from "../mutators/createMutatorTx.js";
import type { LiveOntologyWriteMode, LiveOntologyWriteVisibility } from "../LiveOntology.js";
import type { OntologyCollection } from "../objects/types.js";
import type { OntologyApplyActionResult } from "../OntologyBackendAdapter.js";
import type { OntologyActionRequest } from "../outbox/types.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { OntologyObject } from "@party-stack/ontology-spec";
import type { Uncertain } from "@party-stack/ontology-spec/utils";
import type { ValidationIssue } from "@party-stack/ontology-spec/utils";
import type { Result } from "@party-stack/ontology-spec/values";

export interface LiveOntologyActionOptions {
    idempotencyKey?: string;
    /** Portable inputs supplied by a forwarding ontology. */
    replay?: import("../expression.js").ExpressionReplay;
    /** Direct requires connectivity before admission; outbox permits offline queueing.
     * Both modes return a Promise of authoritative confirmation and local reconciliation.
     */
    mode?: LiveOntologyWriteMode;
    visibility?: LiveOntologyWriteVisibility;
}

export interface LiveOntologyActionDraftValidationOptions<Parameters extends Record<string, unknown>> {
    knownParameters?: readonly (keyof Parameters)[];
}

export type LiveOntologyAction<Parameters extends Record<string, unknown> = Record<string, unknown>> = {
    /** Optimistic visibility is independent of waiting: the Promise resolves after confirmation. */
    (parameters: Parameters, options?: LiveOntologyActionOptions): Promise<OntologyApplyActionResult>;
    resolveParameters(parameters: Partial<Parameters>): Promise<Partial<Parameters>>;
    validate(parameters: Parameters): Promise<Uncertain<Result<void, readonly ValidationIssue[]>>>;
    validateDraft(
        parameters: Partial<Parameters>,
        options?: LiveOntologyActionDraftValidationOptions<Parameters>
    ): Promise<Uncertain<Result<void, readonly ValidationIssue[]>>>;
};

export function createLiveOntologyAction(options: {
    ir: OntologyIR;
    action: OntologyIR["actionTypes"][number];
    context?: Record<string, unknown>;
    objects: Record<string, OntologyCollection<OntologyObject>>;
    resolveParameters?: (
        name: string,
        parameters: Record<string, unknown>
    ) => Promise<Record<string, unknown>>;
    submit(
        request: OntologyActionRequest,
        options?: LiveOntologyActionOptions
    ): Promise<OntologyApplyActionResult>;
    validate(
        actionTypeName: string,
        parameters: Record<string, unknown>
    ): Promise<Uncertain<Result<void, readonly ValidationIssue[]>>>;
    validateDraft(
        actionTypeName: string,
        parameters: Record<string, unknown>,
        validationOptions?: LiveOntologyActionDraftValidationOptions<Record<string, unknown>>
    ): Promise<Uncertain<Result<void, readonly ValidationIssue[]>>>;
}): LiveOntologyAction {
    const resolveParameters = (providedParameters: Record<string, unknown>) =>
        options.resolveParameters
            ? options.resolveParameters(options.action.name, providedParameters)
            : resolveActionParameters({
                  ir: options.ir,
                  actionTypeName: options.action.name,
                  initialParameters: providedParameters,
                  context: options.context ?? {},
                  tx: createReadTx(options.objects),
              });
    const apply: LiveOntologyAction = async (providedParameters, executionOptions) => {
        const idempotencyKey = executionOptions?.idempotencyKey ?? crypto.randomUUID();
        return options.submit(
            {
                actionTypeName: options.action.name,
                parameters: providedParameters,
                idempotencyKey,
                replay: executionOptions?.replay,
            },
            executionOptions
        );
    };
    apply.validate = async (providedParameters) => options.validate(options.action.name, providedParameters);
    apply.resolveParameters = resolveParameters;
    apply.validateDraft = async (parameters, validationOptions) =>
        options.validateDraft(options.action.name, parameters, validationOptions);
    return apply;
}
