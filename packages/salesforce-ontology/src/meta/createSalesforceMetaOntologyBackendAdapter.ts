import { notImplemented } from "@bobbyfidz/panic";
import { actionTypeCollectionOptions } from "./actionTypeCollectionOptions.js";
import {
    linkTypeCollectionOptions,
    objectTypeCollectionOptions,
    valueTypeCollectionOptions,
} from "./entityCollectionOptions.js";
import { queryFunctionTypeCollectionOptions } from "./queryFunctionTypeCollectionOptions.js";
import type { SalesforceCrudActionTypeSelection } from "../crud.js";
import type { OntologyBackendAdapter } from "@party-stack/ontology";
import type { SalesforceClient } from "@party-stack/salesforce-client";

export interface CreateSalesforceMetaOntologyBackendAdapterOpts {
    client: SalesforceClient;
    /**
     * Optional allowlist of sObject API names for metadata loading.
     * Useful for scoped form pulls without describing the entire org.
     */
    objectTypeNames?: string[];
    /** Optional allowlist of autolaunched Flow API names. */
    flowActionTypeNames?: string[];
    /** Standard Salesforce operations modeled as mutating actions. */
    standardActionTypeNames?: string[];
    /** Standard Salesforce operations modeled as query functions. */
    standardQueryFunctionTypeNames?: string[];
    /** Explicit CRUD actions to synthesize from sObject describe metadata. */
    crudActionTypes?: readonly SalesforceCrudActionTypeSelection[];
}

export function createSalesforceMetaOntologyBackendAdapter(
    opts: CreateSalesforceMetaOntologyBackendAdapterOpts
): OntologyBackendAdapter {
    const entityOptions = {
        client: opts.client,
        objectTypeNames: opts.objectTypeNames,
    };

    return {
        name: "salesforce-metadata",
        getCollectionOptions: (objectType: string) => {
            switch (objectType) {
                case "ObjectType":
                    return objectTypeCollectionOptions(entityOptions);
                case "ValueType":
                    return valueTypeCollectionOptions();
                case "LinkType":
                    return linkTypeCollectionOptions(entityOptions);
                case "ActionType":
                    return actionTypeCollectionOptions({
                        client: opts.client,
                        flowActionTypeNames: opts.flowActionTypeNames,
                        standardActionTypeNames: opts.standardActionTypeNames,
                        crudActionTypes: opts.crudActionTypes,
                    });
                case "QueryFunctionType":
                    return queryFunctionTypeCollectionOptions({
                        client: opts.client,
                        standardQueryFunctionTypeNames: opts.standardQueryFunctionTypeNames,
                    });
                default:
                    throw new Error(`Unsupported Salesforce metadata object type "${objectType}".`);
            }
        },
        applyAction: () => {
            notImplemented();
        },
        runQueryFunction: () => {
            notImplemented();
        },
    };
}
