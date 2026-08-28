import { createFoundryOntologyPullSource } from "@party-stack/foundry-ontology/config";
import { o } from "@party-stack/ontology";
import type { FoundryOntologyPullConfig } from "@party-stack/foundry-ontology/config";
import { foundryUserToUser } from "./user";

const imageConstraint = {
    content: o.AttachmentContentConstraint.image({
        mediaTypes: ["image/png", "image/jpeg"],
    }),
};

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable ${name}.`);
    }
    return value;
}

export default {
    source: createFoundryOntologyPullSource({
        baseUrl: requiredEnv("VITE_FOUNDRY_URL"),
        ontologyRid: requiredEnv("VITE_FOUNDRY_ONTOLOGY_RID"),
        connection: {
            oauth: {
                clientId: requiredEnv("VITE_FOUNDRY_CLIENT_ID"),
                redirectUrl: requiredEnv("VITE_FOUNDRY_REDIRECT_URL"),
            },
        },
        users: {
            objectType: "User",
            lens: foundryUserToUser,
        },
        // TODO: scrap this
        attachmentConstraints: [
            {
                target: {
                    kind: "objectProperty",
                    objectType: "Issue",
                    property: "issueAttachments",
                },
                constraint: imageConstraint,
            },
            {
                target: {
                    kind: "actionParameter",
                    actionType: "createIssue",
                    parameter: "attachments",
                },
                constraint: imageConstraint,
            },
            {
                target: {
                    kind: "actionParameter",
                    actionType: "updateIssue",
                    parameter: "attachments",
                },
                constraint: imageConstraint,
            },
        ],
    }),
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
