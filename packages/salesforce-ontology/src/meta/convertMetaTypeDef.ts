import type { StringConstraint, TypeDef } from "@party-stack/ontology";
import type {
    Field,
    SalesforceFieldDescribe,
    SalesforcePicklistValue,
    SalesforceSObjectDescribe,
} from "@party-stack/salesforce-client";

function maybeOptional(type: TypeDef, nillable: boolean): TypeDef {
    return nillable && type.kind !== "optional" ? { kind: "optional", value: { type } } : type;
}

function asPicklistValues(values: Field["picklistValues"] | null | undefined): SalesforcePicklistValue[] {
    if (!Array.isArray(values)) {
        return [];
    }
    return values;
}

function picklistConstraint(
    values: Field["picklistValues"] | null | undefined
): StringConstraint | undefined {
    const options = asPicklistValues(values)
        .filter((value) => value.active)
        .map((value) => ({ value: value.value, label: value.label ?? undefined }));
    return options.length > 0 ? { kind: "enum", value: { options } } : undefined;
}

/**
 * Convert a Salesforce field describe into a Party Stack TypeDef.
 * Unsupported/compound provider-specific shapes become `unknown`.
 */
export function convertSalesforceFieldType(field: SalesforceFieldDescribe): TypeDef {
    const baseType = convertSalesforceSoapType(field);
    return maybeOptional(baseType, field.nillable && field.type !== "id" && field.name !== "Id");
}

function convertSalesforceSoapType(field: SalesforceFieldDescribe): TypeDef {
    switch (field.type) {
        case "id":
        case "string":
        case "textarea":
        case "url":
        case "email":
        case "phone":
        case "encryptedstring":
        case "combobox":
        case "anyType":
            return { kind: "string", value: {} };
        case "picklist":
        case "multipicklist": {
            const constraint = picklistConstraint(field.picklistValues);
            if (field.type === "multipicklist") {
                return { kind: "list", value: { elementType: { kind: "string", value: { constraint } } } };
            }
            return { kind: "string", value: { constraint } };
        }
        case "boolean":
            return { kind: "boolean", value: {} };
        case "int":
        case "long":
            return { kind: "integer", value: {} };
        case "double":
        case "currency":
        case "percent":
            return { kind: "double", value: {} };
        case "date":
            return { kind: "date", value: {} };
        case "datetime":
            return { kind: "timestamp", value: {} };
        case "time":
            // Party Stack has no dedicated time type yet.
            return { kind: "string", value: {} };
        case "reference": {
            const referenceTo = field.referenceTo ?? [];
            if (referenceTo.length === 1) {
                return { kind: "objectReference", value: { objectType: referenceTo[0]! } };
            }
            // Polymorphic references stay scalar until multi-target links exist.
            return { kind: "string", value: {} };
        }
        case "location":
        case "address":
            // Compound location/address fields are exposed as unknown; individual
            // latitude/longitude components appear as separate fields when available.
            return { kind: "unknown", value: {} };
        case "base64":
        case "blob":
        case "complexvalue":
        case "json":
        case "datacategorygroupreference":
        default:
            return { kind: "unknown", value: {} };
    }
}

export function convertSalesforceInvocableParameterType(
    parameter: {
        type?: string | null;
        sobjectType?: string | null;
        sObjectType?: string | null;
        required?: boolean;
        maxOccurs?: number | null;
        picklistValues?: SalesforcePicklistValue[] | null;
    },
    sObjectDescribe?: SalesforceSObjectDescribe
): TypeDef {
    const required = parameter.required === true;
    let baseType: TypeDef;
    const typeName = parameter.type?.toLowerCase() ?? "unknown";
    const sObjectType = parameter.sobjectType ?? parameter.sObjectType;
    if (typeName === "sobject" && sObjectType && sObjectDescribe) {
        baseType = {
            kind: "struct",
            value: {
                fields: sObjectDescribe.fields
                    .filter((field) => field.type !== "address" && field.type !== "location")
                    .map((field) => ({
                        name: field.name,
                        displayName: field.label || field.name,
                        description: field.inlineHelpText ?? undefined,
                        type: maybeOptional(convertSalesforceFieldType(field), true),
                    })),
            },
        };
    } else if (sObjectType && (typeName === "id" || typeName === "reference")) {
        baseType = { kind: "objectReference", value: { objectType: sObjectType } };
    } else {
        switch (typeName) {
            case "string":
            case "id":
            case "textarea":
            case "url":
            case "email":
            case "phone":
                baseType = { kind: "string", value: {} };
                break;
            case "picklist":
                baseType = {
                    kind: "string",
                    value: { constraint: picklistConstraint(parameter.picklistValues) },
                };
                break;
            case "boolean":
                baseType = { kind: "boolean", value: {} };
                break;
            case "integer":
            case "int":
            case "long":
                baseType = { kind: "integer", value: {} };
                break;
            case "double":
            case "currency":
            case "percent":
            case "number":
            case "decimal":
                baseType = { kind: "double", value: {} };
                break;
            case "date":
                baseType = { kind: "date", value: {} };
                break;
            case "datetime":
                baseType = { kind: "timestamp", value: {} };
                break;
            case "sobject":
                baseType = { kind: "unknown", value: {} };
                break;
            case "reference":
                baseType = { kind: "string", value: {} };
                break;
            default:
                baseType = { kind: "unknown", value: {} };
                break;
        }
    }
    if (typeof parameter.maxOccurs === "number" && parameter.maxOccurs > 1) {
        baseType = { kind: "list", value: { elementType: baseType } };
    }
    return required ? baseType : { kind: "optional", value: { type: baseType } };
}
