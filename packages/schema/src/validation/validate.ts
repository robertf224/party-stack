import type { SchemaIR, TypeDef, FieldDef, VariantDef } from "../ir/ir.js";

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
            return [];

        case "list":
            return validateTypeDef(type.elementType, [...path, "elementType"], typeNames);

        case "map": {
            const errors: ValidationError[] = [];
            if (type.keyType.kind !== "string") {
                errors.push({
                    message: "Map key types must be string.",
                    path: [...path, "keyType"],
                });
            }
            return [
                ...errors,
                ...validateTypeDef(type.keyType, [...path, "keyType"], typeNames),
                ...validateTypeDef(type.valueType, [...path, "valueType"], typeNames),
            ];
        }
        case "struct":
            return validateStructFields(type.fields, [...path, "fields"], typeNames);

        case "union":
            return validateUnionVariants(type.variants, [...path, "variants"], typeNames);

        case "result":
            return [
                ...validateTypeDef(type.okType, [...path, "okType"], typeNames),
                ...validateTypeDef(type.errType, [...path, "errType"], typeNames),
            ];

        case "ref":
            return typeNames.has(type.apiName)
                ? []
                : [{ message: "Unknown type reference.", path: [...path, "apiName"] }];
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

        if (fieldNames.has(field.apiName)) {
            errors.push({ message: "Duplicate field name.", path: [...fieldPath, "apiName"] });
        }
        fieldNames.add(field.apiName);

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

        if (seen.has(variant.apiName)) {
            errors.push({ message: "Duplicate variant name.", path: [...variantPath, "apiName"] });
        }
        seen.add(variant.apiName);

        errors.push(...validateTypeDef(variant.type, [...variantPath, "type"], typeNames));
    }

    return errors;
}

export function validate(schema: SchemaIR): ValidationResult {
    const typeNames = new Set<string>();
    const errors: ValidationError[] = [];

    for (let index = 0; index < schema.types.length; index++) {
        const typeName = schema.types[index]!.apiName;
        if (typeNames.has(typeName)) {
            errors.push({
                message: "Duplicate type name.",
                path: ["types", index, "apiName"],
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
