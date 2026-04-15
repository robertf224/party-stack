import { invariant } from "@bobbyfidz/panic";
import type { OntologyIR, TypeDef } from "../ir/generated/types.js";

// TODO: clean this up a bit when we have a better notion of paths

export interface OntologyPropertyTarget {
    objectType: string;
    property: string;
}

function resolveTypeRef(ir: OntologyIR, type: TypeDef): TypeDef {
    if (type.kind !== "ref") {
        return type;
    }
    const resolvedType = ir.types.find((candidate) => candidate.name === type.value.name)?.type;
    invariant(resolvedType !== undefined, `Unknown type reference "${type.value.name}".`);
    return resolvedType;
}

export function unwrapValueType(ir: OntologyIR, type: TypeDef): TypeDef {
    if (type.kind === "optional") {
        return unwrapValueType(ir, type.value.type);
    }
    if (type.kind === "list") {
        return unwrapValueType(ir, type.value.elementType);
    }
    const resolvedType = resolveTypeRef(ir, type);
    invariant(resolvedType.kind !== "ref", "Type references must resolve to a concrete type.");
    return resolvedType === type ? type : unwrapValueType(ir, resolvedType);
}

export function getTargetValueType(ir: OntologyIR, target: OntologyPropertyTarget): TypeDef {
    const objectType = ir.objectTypes.find((candidate) => candidate.name === target.objectType);
    invariant(objectType !== undefined, `Unknown object type "${target.objectType}".`);
    const property = objectType.properties.find((candidate) => candidate.name === target.property);
    invariant(property !== undefined, `Unknown property "${target.property}" on "${target.objectType}".`);
    return unwrapValueType(ir, property.type);
}
