import {
    NonRetryableError,
    type OntologyBackendAdapter,
    type OntologyBackendAdapterProvider,
    type OntologyIR,
} from "@party-stack/ontology";
import { SalesforceApiError, type SalesforceClient } from "@party-stack/salesforce-client";
import { Effect } from "effect";
import { getSalesforceActionMetadata } from "../actionMetadata.js";
import { makeSalesforceBackend } from "./backend.js";
import { createSalesforceCodec } from "./salesforceCodec.js";
import type {
    SalesforceChangeEvent,
    SalesforceChangeEventSubscription,
    SalesforceChangeEventSubscriptionOptions,
} from "@party-stack/salesforce-client";

export type SubscribeToSalesforceChangeEvents = (
    objectType: string,
    listener: (event: SalesforceChangeEvent) => void,
    options?: SalesforceChangeEventSubscriptionOptions
) => Promise<SalesforceChangeEventSubscription>;
import type { ActionReceipt } from "@party-stack/ontology-backend";

function isNonRetryableSalesforceError(error: unknown): boolean {
    if (!(error instanceof SalesforceApiError)) {
        return false;
    }
    if (error.statusCode === 400 || error.statusCode === 403 || error.statusCode === 404) {
        return true;
    }
    const code = error.errorCode?.toUpperCase();
    return (
        code === "INVALID_INPUT" ||
        code === "REQUIRED_FIELD_MISSING" ||
        code === "FIELD_CUSTOM_VALIDATION_EXCEPTION" ||
        code === "INSUFFICIENT_ACCESS" ||
        code === "INSUFFICIENT_ACCESS_OR_READONLY" ||
        code === "NOT_FOUND"
    );
}

function assertSaveSucceeded(result: { success: boolean; errors: Array<{ message: string }> }): void {
    if (result.success) return;
    throw new NonRetryableError(
        result.errors
            .map((error) => error.message)
            .filter(Boolean)
            .join("; ") || "Salesforce rejected the record write."
    );
}

export function createSalesforceOntologyBackendAdapter(opts: {
    client: SalesforceClient;
    ir: OntologyIR;
    subscribeToChangeEvents?: SubscribeToSalesforceChangeEvents;
    live?: boolean;
}): OntologyBackendAdapter {
    const codec = createSalesforceCodec(opts.ir);
    const encodeInvocableParameter = (
        type: Parameters<typeof codec.encodeValue>[0],
        value: unknown
    ): unknown => {
        if (type.kind === "optional") {
            return encodeInvocableParameter(type.value.type, value);
        }
        if (type.kind === "list" && Array.isArray(value)) {
            return value.map((entry) => codec.encodeValue(type.value.elementType, entry));
        }
        return codec.encodeValue(type, value);
    };

    async function submitAction(
        name: string,
        parameters: Record<string, unknown>,
        client: SalesforceClient = opts.client
    ): Promise<Pick<ActionReceipt, "affected" | "affectedComplete">> {
        const actionType = opts.ir.actionTypes.find((candidate) => candidate.name === name);
        if (!actionType) {
            throw new NonRetryableError(`Unknown Salesforce action type "${name}".`);
        }

        const parameterTypes = new Map(
            actionType.parameters.map((parameter) => [parameter.name, parameter.type])
        );
        const requestParameters: Record<string, unknown> = {};
        for (const [parameterName, value] of Object.entries(parameters)) {
            if (value === undefined) continue;
            const parameterType = parameterTypes.get(parameterName);
            requestParameters[parameterName] = parameterType
                ? encodeInvocableParameter(parameterType, value)
                : value;
        }

        const metadata = getSalesforceActionMetadata(actionType);
        if (!metadata) {
            throw new NonRetryableError(`Salesforce action type "${name}" is missing Salesforce metadata.`);
        }
        if (metadata.kind === "crud") {
            if (metadata.operation === "create") {
                const result = await client.createRecord(metadata.objectType, requestParameters);
                assertSaveSucceeded(result);
                return {
                    affected: [
                        { objectType: metadata.objectType, ...(result.id ? { keys: [result.id] } : {}) },
                    ],
                    affectedComplete: false,
                };
            }
            const recordId = requestParameters.recordId;
            if (typeof recordId !== "string" || recordId.length === 0) {
                throw new NonRetryableError(`Salesforce ${metadata.operation} action requires recordId.`);
            }
            if (metadata.operation === "update") {
                const fields = Object.fromEntries(
                    Object.entries(requestParameters).filter(
                        ([parameterName]) => parameterName !== "recordId"
                    )
                );
                const result = await client.updateRecord(metadata.objectType, recordId, fields);
                assertSaveSucceeded(result);
                return {
                    affected: [{ objectType: metadata.objectType, keys: [recordId] }],
                    affectedComplete: false,
                };
            }
            assertSaveSucceeded(await client.deleteRecord(metadata.objectType, recordId));
            return {
                affected: [{ objectType: metadata.objectType, keys: [recordId] }],
                affectedComplete: false,
            };
        }

        const actionApiName = metadata.apiName;

        let results;
        try {
            results =
                metadata.kind === "standard"
                    ? await client.invokeStandardAction(actionApiName, [requestParameters])
                    : await client.invokeFlowAction(actionApiName, [requestParameters]);
        } catch (error) {
            if (isNonRetryableSalesforceError(error)) {
                throw new NonRetryableError(
                    error instanceof Error ? error.message : "Salesforce action invocation failed.",
                    { cause: error }
                );
            }
            throw error;
        }

        const result = results[0];
        if (!result) {
            throw new Error(`Salesforce action "${actionApiName}" returned no results.`);
        }
        if (!result.isSuccess) {
            const message =
                result.errors
                    ?.map((entry) => entry.message)
                    .filter(Boolean)
                    .join("; ") || `Salesforce action "${actionApiName}" failed.`;
            throw new NonRetryableError(message);
        }

        // Flows and standard actions can modify records outside their inputs.
        return { affected: opts.ir.objectTypes.map((type) => ({ objectType: type.name })) };
    }

    async function runQueryFunction(
        name: string,
        parameters: Record<string, unknown>,
        client: SalesforceClient = opts.client
    ): Promise<unknown> {
        const queryFunction = opts.ir.queryFunctionTypes.find((candidate) => candidate.name === name);
        if (!queryFunction) {
            throw new NonRetryableError(`Unknown Salesforce query function type "${name}".`);
        }
        const parameterTypes = new Map(
            queryFunction.parameters.map((parameter) => [parameter.name, parameter.type])
        );
        const requestParameters: Record<string, unknown> = {};
        for (const [parameterName, value] of Object.entries(parameters)) {
            if (value === undefined) continue;
            const parameterType = parameterTypes.get(parameterName);
            requestParameters[parameterName] = parameterType
                ? encodeInvocableParameter(parameterType, value)
                : value;
        }
        const results = await client.invokeStandardAction(name, [requestParameters]);
        const result = results[0];
        if (!result) {
            throw new Error(`Salesforce standard query "${name}" returned no results.`);
        }
        if (!result.isSuccess) {
            throw new NonRetryableError(
                result.errors
                    ?.map((entry) => entry.message)
                    .filter(Boolean)
                    .join("; ") || `Salesforce standard query "${name}" failed.`
            );
        }
        return codec.decodeValue(queryFunction.returnType, result.outputValues ?? {});
    }

    return {
        name: "salesforce",
        open: () =>
            Effect.succeed(
                makeSalesforceBackend({
                    client: opts.client,
                    ir: opts.ir,
                    decodeObject: (objectType, object) => codec.decodeObject(objectType, object),
                    submitAction,
                    runQueryFunction,
                    isRejected: (cause) =>
                        cause instanceof NonRetryableError || isNonRetryableSalesforceError(cause),
                })
            ),
        live: opts.live !== false,
    };
}

export type CreateSalesforceOntologyBackendOptions<
    Context extends Record<string, unknown> = Record<string, unknown>,
> = (
    | {
          client: SalesforceClient;
          subscribeToChangeEvents?: SubscribeToSalesforceChangeEvents;
      }
    | {
          createClient: (ir: OntologyIR, context: Context) => SalesforceClient | Promise<SalesforceClient>;
          subscribeToChangeEvents?: SubscribeToSalesforceChangeEvents;
      }
) & {
    live?: boolean;
};

export function createSalesforceOntologyBackend<
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: CreateSalesforceOntologyBackendOptions<Context>): OntologyBackendAdapterProvider<Context> {
    return async (ir, context) =>
        createSalesforceOntologyBackendAdapter({
            ir,
            client: "client" in opts ? opts.client : await opts.createClient(ir, context),
            subscribeToChangeEvents: opts.subscribeToChangeEvents,
            live: opts.live,
        });
}
