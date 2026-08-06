import { invariant } from "@bobbyfidz/panic";
import type {
    AttachmentConstraint,
    OntologyIR,
    TypeDef,
} from "@party-stack/ontology";
import type { OntologyAttachmentBindingTarget } from "@party-stack/ontology/utils";

// TODO: Remove these overrides once Foundry datasources expose mediaSetRid and
// media-set schemas can drive constraints directly. See:
// ../../../../specs/2026-08-05-foundry-media-support/README.md

export interface FoundryAttachmentConstraintOverride {
    target: OntologyAttachmentBindingTarget;
    constraint: AttachmentConstraint;
}

function withAttachmentConstraint(
    type: TypeDef,
    constraint: AttachmentConstraint
): TypeDef {
    switch (type.kind) {
        case "attachment":
            return {
                ...type,
                value: {
                    ...type.value,
                    constraint,
                },
            };
        case "optional":
            return {
                ...type,
                value: {
                    type: withAttachmentConstraint(type.value.type, constraint),
                },
            };
        case "list":
            return {
                ...type,
                value: {
                    elementType: withAttachmentConstraint(
                        type.value.elementType,
                        constraint
                    ),
                },
            };
        default:
            throw new Error(
                `Foundry attachment constraint target resolved to "${type.kind}", not an attachment.`
            );
    }
}

export function applyAttachmentConstraintOverrides(
    ontology: OntologyIR,
    overrides: FoundryAttachmentConstraintOverride[]
): OntologyIR {
    for (const override of overrides) {
        const target = override.target;
        switch (target.kind) {
            case "objectProperty": {
                const objectType = ontology.objectTypes.find(
                    (candidate) => candidate.name === target.objectType
                );
                invariant(
                    objectType,
                    `Unknown object type "${target.objectType}" in attachment constraint override.`
                );
                const property = objectType.properties.find(
                    (candidate) => candidate.name === target.property
                );
                invariant(
                    property,
                    `Unknown property "${target.property}" on "${target.objectType}" in attachment constraint override.`
                );
                property.type = withAttachmentConstraint(
                    property.type,
                    override.constraint
                );
                break;
            }
            case "actionParameter": {
                const actionType = ontology.actionTypes.find(
                    (candidate) => candidate.name === target.actionType
                );
                invariant(
                    actionType,
                    `Unknown action type "${target.actionType}" in attachment constraint override.`
                );
                const parameter = actionType.parameters.find(
                    (candidate) => candidate.name === target.parameter
                );
                invariant(
                    parameter,
                    `Unknown parameter "${target.parameter}" on "${target.actionType}" in attachment constraint override.`
                );
                parameter.type = withAttachmentConstraint(
                    parameter.type,
                    override.constraint
                );
                break;
            }
        }
    }
    return ontology;
}
