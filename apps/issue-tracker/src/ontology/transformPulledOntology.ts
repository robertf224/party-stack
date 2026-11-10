import { createFoundryUserObjectType } from "@party-stack/foundry-ontology/users";
import { o, type OntologyIR, type TypeDef } from "@party-stack/ontology-spec";
import { foundryUserToUser } from "./user";

function imageAttachments(type: TypeDef): TypeDef {
    switch (type.kind) {
        case "attachment":
            return {
                ...type,
                value: {
                    ...type.value,
                    constraint: {
                        content: o.AttachmentContentConstraint.image({
                            mediaTypes: ["image/png", "image/jpeg"],
                        }),
                    },
                },
            };
        case "optional":
            return { ...type, value: { ...type.value, type: imageAttachments(type.value.type) } };
        case "list":
            return {
                ...type,
                value: { ...type.value, elementType: imageAttachments(type.value.elementType) },
            };
        default:
            throw new Error(`Expected an issue attachment type, received ${type.kind}.`);
    }
}

export function transformPulledOntology(pulled: OntologyIR): OntologyIR {
    const ontology = structuredClone(pulled);
    const attachments = ontology.objectTypes
        .find((type) => type.name === "Issue")
        ?.properties.find((property) => property.name === "issueAttachments");
    if (!attachments) throw new Error("The Foundry definition is missing Issue.issueAttachments.");
    attachments.type = imageAttachments(attachments.type);
    for (const action of ["createIssue", "updateIssue"]) {
        const parameter = ontology.actionTypes
            .find((type) => type.name === action)
            ?.parameters.find((parameter) => parameter.name === "attachments");
        if (!parameter) throw new Error(`The Foundry definition is missing ${action}.attachments.`);
        parameter.type = imageAttachments(parameter.type);
    }
    ontology.objectTypes = [
        ...ontology.objectTypes.filter((type) => type.name !== "User"),
        createFoundryUserObjectType("User", foundryUserToUser),
    ];
    ontology.context ??= {
        type: o.struct({
            fields: [
                { name: "userId", displayName: "User", type: o.objectReference({ objectType: "User" }) },
            ],
        }),
        partition: [["userId"]],
    };
    return ontology;
}
