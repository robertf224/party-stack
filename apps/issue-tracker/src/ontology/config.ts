import { foundryOntologyPullSource } from "@party-stack/foundry-ontology/config";
import { o } from "@party-stack/ontology";
import type { FoundryOntologyPullConfig } from "@party-stack/foundry-ontology/config";
import { foundryUserToUser } from "./user";

const imageConstraint = {
    content: o.AttachmentContentConstraint.image({
        mediaTypes: ["image/png", "image/jpeg"],
    }),
};

export default {
    source: foundryOntologyPullSource,
    objectTypeNames: ["Issue", "Project"],
    actionTypeNames: [
        "createIssue",
        "createProject",
        "updateIssue",
        "updateProject",
        "deleteProject",
        "deleteIssue",
    ],
    options: {
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
    },
} satisfies FoundryOntologyPullConfig;
