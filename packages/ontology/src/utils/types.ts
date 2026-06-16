import { invariant } from "@bobbyfidz/panic";
import type { OntologyAttachmentCreateTarget } from "./targets.js";
import type { OntologyIR, TypeDef } from "../ir/generated/types.js";

export function unwrapType(type: TypeDef): { type: TypeDef; isOptional: boolean } {
    if (type.kind === "optional") {
        return { type: type.value.type, isOptional: true };
    }
    return { type, isOptional: false };
}

export function resolveType(ir: OntologyIR, type: TypeDef): TypeDef {
    if (type.kind !== "ref") {
        return type;
    }
    const resolvedType = ir.types.find((candidate) => candidate.name === type.value.name)?.type;
    invariant(resolvedType !== undefined, `Unknown type reference "${type.value.name}".`);
    return resolveType(ir, resolvedType);
}

export function unwrapValueType(ir: OntologyIR, type: TypeDef): TypeDef {
    if (type.kind === "optional") {
        return unwrapValueType(ir, type.value.type);
    }
    if (type.kind === "list") {
        return unwrapValueType(ir, type.value.elementType);
    }
    const resolvedType = resolveType(ir, type);
    return resolvedType === type ? type : unwrapValueType(ir, resolvedType);
}

function getObjectPropertyValueType(
    ir: OntologyIR,
    target: { objectType: string; property: string }
): TypeDef {
    const objectType = ir.objectTypes.find((candidate) => candidate.name === target.objectType);
    invariant(objectType !== undefined, `Unknown object type "${target.objectType}".`);
    const property = objectType.properties.find((candidate) => candidate.name === target.property);
    invariant(property !== undefined, `Unknown property "${target.property}" on "${target.objectType}".`);
    return unwrapValueType(ir, property.type);
}

function getActionParameterValueType(
    ir: OntologyIR,
    target: { actionType: string; parameter: string }
): TypeDef {
    const actionType = ir.actionTypes.find((candidate) => candidate.name === target.actionType);
    invariant(actionType !== undefined, `Unknown action type "${target.actionType}".`);
    const parameter = actionType.parameters.find((candidate) => candidate.name === target.parameter);
    invariant(parameter !== undefined, `Unknown parameter "${target.parameter}" on "${target.actionType}".`);
    return unwrapValueType(ir, parameter.type);
}

export function getTargetValueType(ir: OntologyIR, target: OntologyAttachmentCreateTarget): TypeDef {
    switch (target.kind) {
        case "objectProperty":
            return getObjectPropertyValueType(ir, target);
        case "actionParameter":
            return getActionParameterValueType(ir, target);
    }
}
