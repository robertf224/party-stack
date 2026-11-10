import { makeFoundryPullBackend } from "@party-stack/foundry-ontology/config";
import { transformPulledOntology } from "./transformPulledOntology";
import type { FoundryOntologyPullConfig } from "@party-stack/foundry-ontology/config";

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable ${name}.`);
    }
    return value;
}

export default {
    backend: makeFoundryPullBackend({
        baseUrl: requiredEnv("VITE_FOUNDRY_URL"),
        ontologyRid: requiredEnv("VITE_FOUNDRY_ONTOLOGY_RID"),
        connection: {
            oauth: {
                clientId: requiredEnv("VITE_FOUNDRY_CLIENT_ID"),
                redirectUrl: requiredEnv("VITE_FOUNDRY_REDIRECT_URL"),
            },
        },
    }),
    transformPulledOntology,
    objectTypeNames: ["Issue", "Project"],
    actionTypeNames: [
        "createIssue",
        "createProject",
        "updateIssue",
        "updateProject",
        "deleteProject",
        "deleteIssue",
    ],
} satisfies FoundryOntologyPullConfig;
