import type { SchemaIR, TypeDef, FieldDef, VariantDef } from "./generated/types.js";

export type ValidationPathElement = string | number;

export interface ValidationError {
    path: ValidationPathElement[];
    message: string;
}

export type ValidationResult = { kind: "ok" } | { kind: "err"; errors: ValidationError[] };

function validateTypeDef(
    type: TypeDef,
    path: ValidationPathElement[],
    typeNames: Set<string>
): ValidationError[] {
    switch (type.kind) {
        case "string":
        case "boolean":
        case "integer":
        case "float":
        case "double":
        case "date":
        case "timestamp":
        case "geopoint":
        case "attachment":
        case "unknown":
            return [];

        case "list":
            return validateTypeDef(type.value.elementType, [...path, "value", "elementType"], typeNames);

        case "map": {
            const errors: ValidationError[] = [];
            if (type.value.keyType.kind !== "string") {
                errors.push({
                    message: "Map key types must be string.",
                    path: [...path, "value", "keyType"],
                });
            }
            return [
                ...errors,
                ...validateTypeDef(type.value.keyType, [...path, "value", "keyType"], typeNames),
                ...validateTypeDef(type.value.valueType, [...path, "value", "valueType"], typeNames),
            ];
        }
        case "struct":
            return validateStructFields(type.value.fields, [...path, "value", "fields"], typeNames);

        case "union":
            return validateUnionVariants(type.value.variants, [...path, "value", "variants"], typeNames);

        case "optional":
            return validateTypeDef(type.value.type, [...path, "value", "type"], typeNames);

        case "result":
            return [
                ...validateTypeDef(type.value.okType, [...path, "value", "okType"], typeNames),
                ...validateTypeDef(type.value.errType, [...path, "value", "errType"], typeNames),
            ];

        case "ref":
            return typeNames.has(type.value.name)
                ? []
                : [{ message: "Unknown type reference.", path: [...path, "value", "name"] }];
    }
}

function validateStructFields(
    fields: FieldDef[],
    path: ValidationPathElement[],
    typeNames: Set<string>
): ValidationError[] {
    const fieldNames = new Set<string>();
    const errors: ValidationError[] = [];

    for (let index = 0; index < fields.length; index++) {
        const field = fields[index]!;
        const fieldPath = [...path, index];

        if (fieldNames.has(field.name)) {
            errors.push({ message: "Duplicate field name.", path: [...fieldPath, "name"] });
        }
        fieldNames.add(field.name);

        errors.push(...validateTypeDef(field.type, [...fieldPath, "type"], typeNames));
    }

    return errors;
}

function validateUnionVariants(
    variants: VariantDef[],
    path: ValidationPathElement[],
    typeNames: Set<string>
): ValidationError[] {
    const seen = new Set<string>();
    const errors: ValidationError[] = [];

    for (let index = 0; index < variants.length; index++) {
        const variant = variants[index]!;
        const variantPath = [...path, index];

        if (seen.has(variant.name)) {
            errors.push({ message: "Duplicate variant name.", path: [...variantPath, "name"] });
        }
        seen.add(variant.name);

        errors.push(...validateTypeDef(variant.type, [...variantPath, "type"], typeNames));
    }

    return errors;
}

export function validate(schema: SchemaIR): ValidationResult {
    const typeNames = new Set<string>();
    const errors: ValidationError[] = [];

    for (let index = 0; index < schema.types.length; index++) {
        const typeName = schema.types[index]!.name;
        if (typeNames.has(typeName)) {
            errors.push({
                message: "Duplicate type name.",
                path: ["types", index, "name"],
            });
        }
        typeNames.add(typeName);
    }

    for (let index = 0; index < schema.types.length; index++) {
        const namedType = schema.types[index]!;
        errors.push(...validateTypeDef(namedType.type, [], typeNames));
    }

    return errors.length === 0 ? { kind: "ok" } : { kind: "err", errors };
}
