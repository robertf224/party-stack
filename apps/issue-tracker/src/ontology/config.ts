import { foundryOntologyConfigAdapter, FoundryOntologyConfig } from "@party-stack/foundry-ontology/config";

export default {
    adapter: foundryOntologyConfigAdapter,
    objectTypeNames: ["Task"],
} satisfies FoundryOntologyConfig;
