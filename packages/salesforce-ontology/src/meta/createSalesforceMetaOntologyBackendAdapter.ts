import { notImplemented } from "@bobbyfidz/panic";
import type { OntologyBackendAdapter } from "@party-stack/ontology";
import type { SalesforceClient } from "@party-stack/salesforce-client";
import { actionTypeCollectionOptions } from "./actionTypeCollectionOptions.js";
import {
    createMetaEntityCollection,
    linkTypeCollectionOptions,
    objectTypeCollectionOptions,
    valueTypeCollectionOptions,
} from "./entityCollectionOptions.js";
import { queryFunctionTypeCollectionOptions } from "./queryFunctionTypeCollectionOptions.js";

export interface CreateSalesforceMetaOntologyBackendAdapterOpts {
    client: SalesforceClient;
    /**
     * Optional allowlist of sObject API names for metadata loading.
     * Useful for scoped form pulls without describing the entire org.
     */
    objectTypeNames?: string[];
    /** Optional allowlist of autolaunched Flow API names. */
    actionTypeNames?: string[];
}

export function createSalesforceMetaOntologyBackendAdapter(
    opts: CreateSalesforceMetaOntologyBackendAdapterOpts
): OntologyBackendAdapter {
    const metadata = createMetaEntityCollection({
        client: opts.client,
        objectTypeNames: opts.objectTypeNames,
    });

    return {
        name: "salesforce-metadata",
        getCollectionOptions: (objectType: string) => {
            switch (objectType) {
                case "ObjectType":
                    return objectTypeCollectionOptions(metadata);
                case "ValueType":
                    return valueTypeCollectionOptions(metadata);
                case "LinkType":
                    return linkTypeCollectionOptions(metadata);
                case "ActionType":
                    return actionTypeCollectionOptions({
                        client: opts.client,
                        actionTypeNames:
                            opts.actionTypeNames,
                    });
                case "QueryFunctionType":
                    return queryFunctionTypeCollectionOptions();
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
        cleanup: async () => {
            await metadata.cleanup();
        },
    };
}
