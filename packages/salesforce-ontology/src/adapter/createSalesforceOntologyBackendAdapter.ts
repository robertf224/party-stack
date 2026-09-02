import {
    NonRetryableError,
    type OntologyBackendAdapter,
    type OntologyBackendAdapterProvider,
    type OntologyIR,
} from "@party-stack/ontology";
import { SalesforceApiError, type SalesforceClient } from "@party-stack/salesforce-client";
import { Collection } from "@tanstack/db";
import { getSalesforceFlowApiNameFromActionType } from "../meta/convertMetaActionType.js";
import { objectCollectionOptions, type ObjectCollectionUtils } from "./objectCollectionOptions.js";
import { createSalesforceCodec } from "./salesforceCodec.js";

type CollectionWithUtils = Collection<
    Record<string, unknown>,
    string | number,
    ObjectCollectionUtils
>;

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

function invalidateEditedCollections(objects: Record<string, Collection<Record<string, unknown>>>): void {
    for (const collection of Object.values(objects)) {
        const utils = (collection as CollectionWithUtils).utils;
        utils?.invalidate?.();
    }
}

export function createSalesforceOntologyBackendAdapter(opts: {
    client: SalesforceClient;
    ir: OntologyIR;
}): OntologyBackendAdapter {
    const codec = createSalesforceCodec(opts.ir);

    return {
        name: "salesforce",
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
                decodeObject: (object) => codec.decodeObject(objectType, object),
            });
        },
        applyAction: async (name, parameters, live) => {
            const actionType = opts.ir.actionTypes.find((candidate) => candidate.name === name);
            if (!actionType) {
                throw new NonRetryableError(`Unknown Salesforce action type "${name}".`);
            }

            const parameterTypes = new Map(actionType.parameters.map((parameter) => [parameter.name, parameter.type]));
            const requestParameters: Record<string, unknown> = {};
            for (const [parameterName, value] of Object.entries(parameters)) {
                if (value === undefined) continue;
                const parameterType = parameterTypes.get(parameterName);
                requestParameters[parameterName] = parameterType
                    ? codec.encodeValue(parameterType, value)
                    : value;
            }

            const flowApiName = getSalesforceFlowApiNameFromActionType(actionType);

            let results;
            try {
                results = await opts.client.invokeFlowAction(flowApiName, [requestParameters]);
            } catch (error) {
                if (isNonRetryableSalesforceError(error)) {
                    throw new NonRetryableError(
                        error instanceof Error ? error.message : "Salesforce Flow invocation failed.",
                        { cause: error }
                    );
                }
                throw error;
            }

            const result = results[0];
            if (!result) {
                throw new Error(`Salesforce Flow "${flowApiName}" returned no results.`);
            }
            if (!result.isSuccess) {
                const message =
                    result.errors?.map((entry) => entry.message).filter(Boolean).join("; ") ||
                    `Salesforce Flow "${flowApiName}" failed.`;
                throw new NonRetryableError(message);
            }

            invalidateEditedCollections(live.objects);
        },
        runQueryFunction: (name) =>
            Promise.reject(
                new Error(
                    `Salesforce ontology adapter cannot run query function type "${name}". Query functions are not supported in this slice.`
                )
            ),
    };
}

export type CreateSalesforceOntologyBackendOptions<
    Context extends Record<string, unknown> = Record<string, unknown>,
> =
    | {
          client: SalesforceClient;
      }
    | {
          createClient: (ir: OntologyIR, context: Context) => SalesforceClient | Promise<SalesforceClient>;
      };

export function createSalesforceOntologyBackend<
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: CreateSalesforceOntologyBackendOptions<Context>): OntologyBackendAdapterProvider<Context> {
    return async (ir, context) =>
        createSalesforceOntologyBackendAdapter({
            ir,
            client: "client" in opts ? opts.client : await opts.createClient(ir, context),
        });
}
