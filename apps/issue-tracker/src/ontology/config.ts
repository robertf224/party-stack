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
    objectTypeNames: ["Task"],
    actionTypeNames: ["createTask", "completeTask", "reopenTask", "deleteTask"],
    opts: {
        attachmentConstraints: [
            {
                target: {
                    kind: "objectProperty",
                    objectType: "Task",
                    property: "media",
                },
                constraint: imageConstraint,
            },
            {
                target: {
                    kind: "actionParameter",
                    actionType: "createTask",
                    parameter: "media",
                },
                constraint: imageConstraint,
            },
        ],
    },
} satisfies FoundryOntologyConfig;
