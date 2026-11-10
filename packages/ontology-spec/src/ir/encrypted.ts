import type { ValidationIssue } from "../utils/validation.js";
import type { OntologyIR, TypeDef } from "./generated/types.js";

function containsEncrypted(type: TypeDef): boolean {
    switch (type.kind) {
        case "encrypted":
            return true;
        case "optional":
            return containsEncrypted(type.value.type);
        case "list":
            return containsEncrypted(type.value.elementType);
        case "map":
            return containsEncrypted(type.value.keyType) || containsEncrypted(type.value.valueType);
        case "result":
            return containsEncrypted(type.value.okType) || containsEncrypted(type.value.errType);
        case "struct":
            return type.value.fields.some((field) => containsEncrypted(field.type));
        case "union":
            return type.value.variants.some((variant) => containsEncrypted(variant.type));
        default:
            return false;
    }
}

/** Reject encrypted wrappers anywhere inside another encrypted value, including named types. */
export function nestedEncryptedIssues(ir: OntologyIR): ValidationIssue[] {
    // Named definitions are themselves roots, so this structural pass need not
    // expand references. Without any wrapper there can be no nested wrapper.
    if (
        !ir.types.some((entry) => containsEncrypted(entry.type)) &&
        !(ir.context?.type && containsEncrypted(ir.context.type)) &&
        !ir.objectTypes.some((object) =>
            object.properties.some((property) => containsEncrypted(property.type))
        ) &&
        !ir.actionTypes.some(
            (action) =>
                (action.returnType && containsEncrypted(action.returnType)) ||
                action.parameters.some((parameter) => containsEncrypted(parameter.type))
        ) &&
        !ir.queryFunctionTypes.some(
            (query) =>
                containsEncrypted(query.returnType) ||
                query.parameters.some((parameter) => containsEncrypted(parameter.type))
        )
    )
        return [];
    const issues: ValidationIssue[] = [];
    const definitions = new Map(ir.types.map((entry) => [entry.name, entry.type]));
    function visit(type: TypeDef, path: (string | number)[], encrypted = false, refs = new Set<string>()) {
        const child = (value: TypeDef, key: string) => visit(value, [...path, "value", key], encrypted, refs);
        switch (type.kind) {
            case "encrypted":
                if (encrypted)
                    issues.push({
                        message: "Encrypted values cannot contain another encrypted wrapper.",
                        path,
                    });
                else visit(type.value.type, [...path, "value", "type"], true, refs);
                break;
            case "ref": {
                const name = type.value.name;
                const value = definitions.get(name);
                if (value && !refs.has(name)) visit(value, path, encrypted, new Set([...refs, name]));
                break;
            }
            case "optional":
                child(type.value.type, "type");
                break;
            case "list":
                child(type.value.elementType, "elementType");
                break;
            case "map":
                child(type.value.keyType, "keyType");
                child(type.value.valueType, "valueType");
                break;
            case "result":
                child(type.value.okType, "okType");
                child(type.value.errType, "errType");
                break;
            case "struct":
                type.value.fields.forEach((field, index) =>
                    visit(field.type, [...path, "value", "fields", index, "type"], encrypted, refs)
                );
                break;
            case "union":
                type.value.variants.forEach((variant, index) =>
                    visit(variant.type, [...path, "value", "variants", index, "type"], encrypted, refs)
                );
                break;
        }
    }
    if (ir.context?.type) visit(ir.context?.type, ["context", "type"]);
    ir.types.forEach((entry, index) => visit(entry.type, ["types", index, "type"]));
    ir.objectTypes.forEach((object, index) =>
        object.properties.forEach((property, propertyIndex) =>
            visit(property.type, ["objectTypes", index, "properties", propertyIndex, "type"])
        )
    );
    ir.actionTypes.forEach((action, index) => {
        if (action.returnType) visit(action.returnType, ["actionTypes", index, "returnType"]);
        action.parameters.forEach((parameter, parameterIndex) =>
            visit(parameter.type, ["actionTypes", index, "parameters", parameterIndex, "type"])
        );
    });
    ir.queryFunctionTypes.forEach((query, index) => {
        query.parameters.forEach((parameter, parameterIndex) =>
            visit(parameter.type, ["queryFunctionTypes", index, "parameters", parameterIndex, "type"])
        );
        visit(query.returnType, ["queryFunctionTypes", index, "returnType"]);
    });
    return issues;
}
