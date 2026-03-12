import { foundryOntologyConfigAdapter, FoundryOntologyConfig } from "@party-stack/foundry-ontology/config";

export default {
    adapter: foundryOntologyConfigAdapter,
    objectTypeNames: ["StreamlineForm", "StreamlineFormRevision"],
} satisfies FoundryOntologyConfig;
