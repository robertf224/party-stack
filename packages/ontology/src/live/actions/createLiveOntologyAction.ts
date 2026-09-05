import { resolveActionParameters } from "../expression.js";
import { createReadTx } from "../mutators/createMutatorTx.js";
import type { OntologyIR } from "../../ir/index.js";
import type { Uncertain } from "../../utils/uncertain.js";
import type { ValidationIssue } from "../../utils/validation.js";
import type { Result } from "../../utils/values.js";
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

export interface LiveOntologyActionDraftValidationOptions<
    Parameters extends Record<string, unknown>,
> {
    knownParameters?: readonly (keyof Parameters)[];
}

export type LiveOntologyAction<
    Parameters extends Record<string, unknown> = Record<
        string,
        unknown
    >,
> = {
    (
        parameters: Parameters,
        options?: LiveOntologyActionOptions
    ): Promise<OntologyApplyActionResult | void>;
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
    objects: Record<
        string,
        OntologyCollection<OntologyObject>
    >;
    submit(
        request: OntologyActionRequest,
        options?: LiveOntologyActionOptions
    ): Promise<OntologyApplyActionResult | void>;
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
    const resolveParameters = (
        providedParameters: Record<string, unknown>
    ) =>
        resolveActionParameters({
            ir: options.ir,
            actionTypeName: options.action.name,
            initialParameters: providedParameters,
            context: options.context ?? {},
            tx: createReadTx(options.objects),
        });
    const apply: LiveOntologyAction = async (
        providedParameters,
        executionOptions
    ) => {
        const parameters = await resolveParameters(providedParameters);
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
    apply.validate = async (providedParameters) =>
        options.validate(
            options.action.name,
            await resolveParameters(providedParameters)
        );
    apply.validateDraft = async (parameters, validationOptions) =>
        options.validateDraft(
            options.action.name,
            await resolveParameters(parameters),
            validationOptions as LiveOntologyActionDraftValidationOptions<Record<string, unknown>>
        );
    return apply;
}
