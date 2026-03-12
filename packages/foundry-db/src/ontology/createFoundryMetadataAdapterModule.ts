import { createFoundryMetadataOntologyAdapter } from "../ontology-metadata/createOntologyMetadataCollections.js";
import {
    createFoundryOntologyClient,
    type FoundryOntologyAuthConfig,
} from "./createFoundryOntologyClient.js";
import type { OntologyAdapterModule } from "@party-stack/ontology";

export type FoundryMetadataAdapterConfig = FoundryOntologyAuthConfig;

export const foundryMetadataAdapterModule: OntologyAdapterModule<FoundryMetadataAdapterConfig> = {
    createAdapter: async (config) => {
        const client = await createFoundryOntologyClient(config);
        return createFoundryMetadataOntologyAdapter({ client });
    },
};
