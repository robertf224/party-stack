import { notImplemented } from "@bobbyfidz/panic";
import type { OntologyClient } from "@party-stack/foundry-client";
import type { OntologyAdapter } from "@party-stack/ontology";
import { actionTypeCollectionOptions } from "./actionTypeCollectionOptions.js";
import {
    createMetaEntityCollection,
    linkTypeCollectionOptions,
    objectTypeCollectionOptions,
    valueTypeCollectionOptions,
} from "./entityCollectionOptions.js";
import { queryFunctionTypeCollectionOptions } from "./queryFunctionTypeCollectionOptions.js";

export interface CreateFoundryMetaOntologyAdapterOpts {
    client: OntologyClient;
}

export function createFoundryMetaOntologyAdapter(
    opts: CreateFoundryMetaOntologyAdapterOpts
): OntologyAdapter {
    const metadata = createMetaEntityCollection({ client: opts.client });

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
                    return actionTypeCollectionOptions({ client: opts.client });
                case "QueryFunctionType":
                    return queryFunctionTypeCollectionOptions({ client: opts.client });
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
