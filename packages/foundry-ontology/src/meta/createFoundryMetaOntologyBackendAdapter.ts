import { notImplemented } from "@bobbyfidz/panic";
import type { OntologyClient } from "@party-stack/foundry-client";
import type { OntologyBackendAdapter } from "@party-stack/ontology";
import { actionTypeCollectionOptions } from "./actionTypeCollectionOptions.js";
import {
    createMetaEntityCollection,
    linkTypeCollectionOptions,
    objectTypeCollectionOptions,
    valueTypeCollectionOptions,
} from "./entityCollectionOptions.js";
import { queryFunctionTypeCollectionOptions } from "./queryFunctionTypeCollectionOptions.js";

export interface CreateFoundryMetaOntologyBackendAdapterOpts {
    client: OntologyClient;
    /** Polling interval in milliseconds, or false to disable polling. Defaults to no polling. */
    refetchInterval?: number | false;
}

export function createFoundryMetaOntologyBackendAdapter(
    opts: CreateFoundryMetaOntologyBackendAdapterOpts
): OntologyBackendAdapter {
    const metadata = createMetaEntityCollection({
        client: opts.client,
        refetchInterval: opts.refetchInterval,
    });

    return {
        name: "foundry-metadata",
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
                        refetchInterval: opts.refetchInterval,
                    });
                case "QueryFunctionType":
                    return queryFunctionTypeCollectionOptions({
                        client: opts.client,
                        refetchInterval: opts.refetchInterval,
                    });
                default:
                    throw new Error(`Unsupported Foundry metadata object type "${objectType}".`);
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
