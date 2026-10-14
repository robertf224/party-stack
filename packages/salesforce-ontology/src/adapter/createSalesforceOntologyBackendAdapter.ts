import {
    NonRetryableError,
    type OntologyBackendAdapter,
    type OntologyBackendAdapterProvider,
    type OntologyIR,
} from "@party-stack/ontology";
import { SalesforceApiError, type SalesforceClient } from "@party-stack/salesforce-client";
import { Collection } from "@tanstack/db";
import { getSalesforceActionMetadata } from "../actionMetadata.js";
import {
    objectCollectionOptions,
    type ObjectCollectionUtils,
    type SubscribeToSalesforceChangeEvents,
} from "./objectCollectionOptions.js";
import { createSalesforceCodec } from "./salesforceCodec.js";

type CollectionWithUtils = Collection<Record<string, unknown>, string | number, ObjectCollectionUtils>;

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

async function awaitInvalidation(utils: ObjectCollectionUtils): Promise<void> {
    try {
        await utils.invalidate();
    } catch (error) {
        throw new NonRetryableError(
            "Salesforce accepted the action, but its collection changes could not be observed.",
            { cause: error }
        );
    }
}

async function invalidateEditedCollections(
    objects: Record<string, Collection<Record<string, unknown>>>
): Promise<void> {
    await Promise.all(
        Object.values(objects).map((collection) =>
            awaitInvalidation((collection as CollectionWithUtils).utils)
        )
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

async function refreshConfirmedRecord(
    collection: CollectionWithUtils | undefined,
    recordId: string | number | undefined
): Promise<void> {
    if (!collection) return;
    const utils: ObjectCollectionUtils = collection.utils;
    if (recordId === undefined) {
        await awaitInvalidation(utils);
        return;
    }
    try {
        await utils.refreshByKey(recordId);
    } catch (error) {
        throw new NonRetryableError(
            `Salesforce accepted the write, but record "${recordId}" could not be observed in its collection.`,
            { cause: error }
        );
    }
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

    return {
        name: "salesforce",
        live: opts.live !== false,
        getCollectionOptions: (objectType: string) => {
            const objectTypeDef = opts.ir.objectTypes.find((candidate) => candidate.name === objectType);
            if (!objectTypeDef) {
                throw new Error(`Unknown Salesforce object type "${objectType}".`);
            }
            return objectCollectionOptions({
                client: opts.client,
                objectType,
                primaryKeyProperty: objectTypeDef.primaryKey,
                selectedProperties: objectTypeDef.properties.map((property) => property.name),
                subscribeToChangeEvents: opts.live === false ? undefined : opts.subscribeToChangeEvents,
                decodeObject: (object) => codec.decodeObject(objectType, object),
            });
        },
        applyAction: async (name, parameters, live) => {
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
                throw new NonRetryableError(
                    `Salesforce action type "${name}" is missing Salesforce metadata.`
                );
            }
            if (metadata.kind === "crud") {
                const collection = live.objects[metadata.objectType] as CollectionWithUtils | undefined;
                if (metadata.operation === "create") {
                    const result = await opts.client.createRecord(metadata.objectType, requestParameters);
                    assertSaveSucceeded(result);
                    if (opts.live !== false) {
                        await refreshConfirmedRecord(collection, result.id);
                    }
                    return;
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
                    const result = await opts.client.updateRecord(metadata.objectType, recordId, fields);
                    assertSaveSucceeded(result);
                    if (opts.live !== false) {
                        await refreshConfirmedRecord(collection, result.id ?? recordId);
                    }
                    return;
                }
                assertSaveSucceeded(await opts.client.deleteRecord(metadata.objectType, recordId));
                if (opts.live !== false && collection) {
                    await collection.utils.deleteByKey(recordId);
                }
                return;
            }

            const actionApiName = metadata.apiName;

            let results;
            try {
                results =
                    metadata.kind === "standard"
                        ? await opts.client.invokeStandardAction(actionApiName, [requestParameters])
                        : await opts.client.invokeFlowAction(actionApiName, [requestParameters]);
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

            if (opts.live !== false) {
                await invalidateEditedCollections(live.objects);
            }
        },
        runQueryFunction: async (name, parameters) => {
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
            const results = await opts.client.invokeStandardAction(name, [requestParameters]);
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
        },
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
