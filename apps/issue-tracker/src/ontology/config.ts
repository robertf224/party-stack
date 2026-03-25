import { foundryOntologyConfigAdapter, FoundryOntologyConfig } from "@party-stack/foundry-ontology/config";

export default {
    adapter: foundryOntologyConfigAdapter,
    objectTypeNames: ["Task"],
    actionTypeNames: ["createTask", "completeTask", "reopenTask", "deleteTask"],
} satisfies FoundryOntologyConfig;
