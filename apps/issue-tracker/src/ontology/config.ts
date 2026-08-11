import { foundryOntologyConfigAdapter } from "@party-stack/foundry-ontology/config";
import { o } from "@party-stack/ontology";
import type { FoundryOntologyConfig } from "@party-stack/foundry-ontology/config";

const imageConstraint = {
    content: o.AttachmentContentConstraint.image({
        mediaTypes: ["image/png", "image/jpeg"],
    }),
};

export default {
    adapter: foundryOntologyConfigAdapter,
    objectTypeNames: ["Issue", "Project"],
    actionTypeNames: [
        "createIssue",
        "createProject",
        "updateIssue",
        "updateProject",
        "deleteProject",
        "deleteIssue",
    ],
    opts: {
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
} satisfies FoundryOntologyConfig;
