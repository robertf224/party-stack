import { invariant } from "@bobbyfidz/panic";
import type { PropertyDef, StringConstraint, TypeDef } from "@party-stack/ontology";
import type {
    ObjectPropertyType,
    StructFieldType,
    ValueTypeConstraint,
    ValueTypeFieldType,
} from "@osdk/foundry.ontologies";

export function convertFoundryValueTypeFieldType(
    type: ValueTypeFieldType,
    constraints: ValueTypeConstraint[] = []
): TypeDef {
    switch (type.type) {
        case "string":
            return { kind: "string", value: { constraint: extractStringConstraint(constraints) } };
        case "boolean":
            return { kind: "boolean", value: {} };
        case "byte":
        case "short":
        case "integer":
        case "long":
            return { kind: "integer", value: {} };
        case "float":
            return { kind: "float", value: {} };
        case "double":
        case "decimal":
            return { kind: "double", value: {} };
        case "date":
            return { kind: "date", value: {} };
        case "timestamp":
            return { kind: "timestamp", value: {} };
        case "array":
            return {
                kind: "list",
                value: {
                    elementType: (() => {
                        invariant(type.subType, "Expected Foundry array subtype.");
                        return convertFoundryValueTypeFieldType(type.subType);
                    })(),
                },
            };
        case "optional":
            return {
                kind: "optional",
                value: {
                    type: (() => {
                        invariant(type.wrappedType, "Expected Foundry optional type.");
                        return convertFoundryValueTypeFieldType(type.wrappedType);
                    })(),
                },
            };
        case "map":
            return {
                kind: "map",
                value: {
                    keyType: (() => {
                        invariant(type.keyType, "Expected Foundry map key type.");
                        return convertFoundryValueTypeFieldType(type.keyType);
                    })(),
                    valueType: (() => {
                        invariant(type.valueType, "Expected Foundry map value type.");
                        return convertFoundryValueTypeFieldType(type.valueType);
                    })(),
                },
            };
        case "struct":
            return {
                kind: "struct",
                value: {
                    fields: type.fields.map((field, index) => ({
                        name: field.name ?? `field${index + 1}`,
                        displayName: field.name ?? `Field ${index + 1}`,
                        type: (() => {
                            invariant(
                                field.fieldType,
                                `Expected Foundry struct field "${field.name ?? index}" type.`
                            );
                            return convertFoundryValueTypeFieldType(field.fieldType);
                        })(),
                    })),
                },
            };
        case "union":
            return {
                kind: "union",
                value: {
                    variants: type.memberTypes.map((memberType, index) => ({
                        name: `variant${index + 1}`,
                        type: convertFoundryValueTypeFieldType(memberType),
                    })),
                },
            };
        default:
            throw new Error(`Unsupported Foundry value type "${type.type}".`);
    }
}

export function convertFoundryObjectPropertyType(type: ObjectPropertyType): TypeDef {
    switch (type.type) {
        case "string":
            return { kind: "string", value: {} };
        case "boolean":
            return { kind: "boolean", value: {} };
        case "byte":
        case "short":
        case "integer":
        case "long":
            return { kind: "integer", value: {} };
        case "float":
            return { kind: "float", value: {} };
        case "double":
        case "decimal":
            return { kind: "double", value: {} };
        case "date":
            return { kind: "date", value: {} };
        case "timestamp":
            return { kind: "timestamp", value: {} };
        case "geopoint":
            return { kind: "geopoint", value: {} };
        case "cipherText":
        case "geoshape":
        case "geotimeSeriesReference":
        case "marking":
        case "timeseries":
            return { kind: "string", value: {} };
        case "attachment":
        case "mediaReference":
            return { kind: "attachment", value: {} };
        case "vector":
            return {
                kind: "list",
                value: {
                    elementType: { kind: "double", value: {} },
                },
            };
        case "array":
            return {
                kind: "list",
                value: {
                    elementType: (() => {
                        invariant(type.subType, "Expected Foundry array subtype.");
                        return convertFoundryObjectPropertyType(type.subType);
                    })(),
                },
            };
        case "struct":
            return {
                kind: "struct",
                value: {
                    fields: type.structFieldTypes.map(convertFoundryStructField),
                },
            };
    }
}

export function convertFoundryStructField(field: StructFieldType): PropertyDef {
    return {
        name: field.apiName,
        displayName: field.apiName,
        type: convertFoundryObjectPropertyType(field.dataType),
    };
}

function extractStringConstraint(constraints: ValueTypeConstraint[]): StringConstraint | undefined {
    const enumConstraint = constraints.find((constraint) => constraint.type === "enum");
    if (enumConstraint) {
        const options = enumConstraint.options
            .filter((option): option is string => typeof option === "string")
            .map((value) => ({ value }));
        if (options.length > 0) {
            return {
                kind: "enum",
                value: { options },
            };
        }
    }

    const regexConstraint = constraints.find((constraint) => constraint.type === "regex");
    if (regexConstraint) {
        return {
            kind: "regex",
            value: { regex: regexConstraint.pattern },
        };
    }

    return undefined;
}
