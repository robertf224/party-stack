import type { OntologyConfig } from "@party-stack/ontology";
import {
    foundryMetadataAdapterModule,
    type FoundryMetadataAdapterConfig,
    getDefaultEnvValue,
} from "@bobbyfidz/foundry-db/ontology";

const config: OntologyConfig<FoundryMetadataAdapterConfig> = {
    adapter: foundryMetadataAdapterModule,
    objectTypeNames: ["StreamlineForm", "StreamlineFormRevision"],
    config: {
        foundryUrl: requiredEnv("FOUNDRY_URL"),
        foundryOntologyRid: requiredEnv("FOUNDRY_ONTOLOGY_RID"),
        foundryClientId: requiredEnv("FOUNDRY_CLIENT_ID"),
        foundryRedirectUrl: requiredEnv("FOUNDRY_REDIRECT_URL"),
    },
};

export default config;

function requiredEnv(key: string): string {
    const value = getDefaultEnvValue(key);
    if (!value) {
        throw new Error(`Missing ${key} for ontology config.`);
    }

    return value;
}
