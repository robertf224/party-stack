import type { OntologyIR, PropertyDef, TypeDef } from "./generated/types.js";

export type ValidationPathElement = string | number;

export interface ValidationError {
    path: ValidationPathElement[];
    message: string;
}

export type ValidationResult = { kind: "ok" } | { kind: "err"; errors: ValidationError[] };

function validateTypeDef(
    type: TypeDef,
    path: ValidationPathElement[],
    valueTypeNames: Set<string>,
    objectTypeNames: Set<string>
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
            return [];

        case "objectReference":
            return objectTypeNames.has(type.value.objectType)
                ? []
                : [
                      {
                          message: `Unknown object type reference: "${type.value.objectType}".`,
                          path: [...path, "objectType"],
                      },
                  ];

        case "list":
            return validateTypeDef(type.value.elementType, [...path, "elementType"], valueTypeNames, objectTypeNames);

        case "map": {
            const errors: ValidationError[] = [];
            if (type.value.keyType.kind !== "string") {
                errors.push({
                    message: "Map key types must be string.",
                    path: [...path, "keyType"],
                });
            }
            return [
                ...errors,
                ...validateTypeDef(type.value.keyType, [...path, "keyType"], valueTypeNames, objectTypeNames),
                ...validateTypeDef(type.value.valueType, [...path, "valueType"], valueTypeNames, objectTypeNames),
            ];
        }

        case "struct":
            return validateStructFields(type.value.fields, [...path, "fields"], valueTypeNames, objectTypeNames);

        case "union":
            return validateUnionVariants(type.value.variants, [...path, "variants"], valueTypeNames, objectTypeNames);

        case "optional":
            return validateTypeDef(type.value.type, [...path, "type"], valueTypeNames, objectTypeNames);

        case "result":
            return [
                ...validateTypeDef(type.value.okType, [...path, "okType"], valueTypeNames, objectTypeNames),
                ...validateTypeDef(type.value.errType, [...path, "errType"], valueTypeNames, objectTypeNames),
            ];

        case "ref":
            return valueTypeNames.has(type.value.name)
                ? []
                : [
                      {
                          message: `Unknown value type reference: "${type.value.name}".`,
                          path: [...path, "name"],
                      },
                  ];
    }
}

function validateStructFields(
    fields: Array<{ name: string; displayName: string; type: TypeDef }>,
    path: ValidationPathElement[],
    valueTypeNames: Set<string>,
    objectTypeNames: Set<string>
): ValidationError[] {
    const fieldNames = new Set<string>();
    const errors: ValidationError[] = [];

    for (let i = 0; i < fields.length; i++) {
        const field = fields[i]!;
        const fieldPath = [...path, i];

        if (fieldNames.has(field.name)) {
            errors.push({ message: `Duplicate field name: "${field.name}".`, path: [...fieldPath, "name"] });
        }
        fieldNames.add(field.name);

        errors.push(...validateTypeDef(field.type, [...fieldPath, "type"], valueTypeNames, objectTypeNames));
    }

    return errors;
}

function validateUnionVariants(
    variants: Array<{ name: string; type: TypeDef }>,
    path: ValidationPathElement[],
    valueTypeNames: Set<string>,
    objectTypeNames: Set<string>
): ValidationError[] {
    const seen = new Set<string>();
    const errors: ValidationError[] = [];

    for (let i = 0; i < variants.length; i++) {
        const variant = variants[i]!;
        const variantPath = [...path, i];

        if (seen.has(variant.name)) {
            errors.push({
                message: `Duplicate variant name: "${variant.name}".`,
                path: [...variantPath, "name"],
            });
        }
        seen.add(variant.name);

        errors.push(...validateTypeDef(variant.type, [...variantPath, "type"], valueTypeNames, objectTypeNames));
    }

    return errors;
}

function validateProperties(
    properties: PropertyDef[],
    path: ValidationPathElement[],
    valueTypeNames: Set<string>,
    objectTypeNames: Set<string>
): ValidationError[] {
    const names = new Set<string>();
    const errors: ValidationError[] = [];

    for (let i = 0; i < properties.length; i++) {
        const prop = properties[i]!;
        const propPath = [...path, i];

        if (names.has(prop.name)) {
            errors.push({
                message: `Duplicate property name: "${prop.name}".`,
                path: [...propPath, "name"],
            });
        }
        names.add(prop.name);

        errors.push(...validateTypeDef(prop.type, [...propPath, "type"], valueTypeNames, objectTypeNames));
    }

    return errors;
}

export function validate(ontology: OntologyIR): ValidationResult {
    const errors: ValidationError[] = [];

    // Collect value type names for ref resolution
    const valueTypeNames = new Set<string>();
    for (let i = 0; i < ontology.types.length; i++) {
        const vt = ontology.types[i]!;
        if (valueTypeNames.has(vt.name)) {
            errors.push({
                message: `Duplicate value type name: "${vt.name}".`,
                path: ["types", i, "name"],
            });
        }
        valueTypeNames.add(vt.name);
    }

    const objectTypeNames = new Set<string>();
    for (let i = 0; i < ontology.objectTypes.length; i++) {
        const ot = ontology.objectTypes[i]!;
        if (objectTypeNames.has(ot.name)) {
            errors.push({
                message: `Duplicate object type name: "${ot.name}".`,
                path: ["objectTypes", i, "name"],
            });
        }
        objectTypeNames.add(ot.name);
    }

    // Validate value type definitions once both namespaces are known.
    for (let i = 0; i < ontology.types.length; i++) {
        const vt = ontology.types[i]!;
        errors.push(...validateTypeDef(vt.type, ["types", i, "type"], valueTypeNames, objectTypeNames));
    }

    // Validate object types
    for (let i = 0; i < ontology.objectTypes.length; i++) {
        const ot = ontology.objectTypes[i]!;
        const otPath = ["objectTypes", i] as ValidationPathElement[];

        // Validate properties
        errors.push(...validateProperties(ot.properties, [...otPath, "properties"], valueTypeNames, objectTypeNames));

        // Validate primary key references a valid property
        const propertyNames = new Set(ot.properties.map((p) => p.name));
        if (!propertyNames.has(ot.primaryKey)) {
            errors.push({
                message: `Primary key "${ot.primaryKey}" does not reference a valid property.`,
                path: [...otPath, "primaryKey"],
            });
        }
    }

    // Validate link types
    const linkIds = new Set<string>();
    const linkNames = new Set<string>();
    for (let i = 0; i < ontology.linkTypes.length; i++) {
        const lt = ontology.linkTypes[i]!;
        const ltPath = ["linkTypes", i] as ValidationPathElement[];

        if (linkIds.has(lt.id)) {
            errors.push({
                message: `Duplicate link type id: "${lt.id}".`,
                path: [...ltPath, "id"],
            });
        }
        linkIds.add(lt.id);

        // Relationship names from a source object are keyed by target.name.
        const linkName = `${lt.source.objectType}:${lt.target.name}`;
        if (linkNames.has(linkName)) {
            errors.push({
                message: `Duplicate link type target name: "${lt.target.name}" on "${lt.source.objectType}".`,
                path: [...ltPath, "target", "name"],
            });
        }
        linkNames.add(linkName);

        if (!objectTypeNames.has(lt.source.objectType)) {
            errors.push({
                message: `Source object type "${lt.source.objectType}" does not exist.`,
                path: [...ltPath, "source", "objectType"],
            });
        }

        if (!objectTypeNames.has(lt.target.objectType)) {
            errors.push({
                message: `Target object type "${lt.target.objectType}" does not exist.`,
                path: [...ltPath, "target", "objectType"],
            });
        }
    }

    return errors.length === 0 ? { kind: "ok" } : { kind: "err", errors };
}
