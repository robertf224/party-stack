import { Temporal } from "temporal-polyfill";
import type {
    ActionParameterDef,
    ActionParameterPrefill,
    TypeDef,
} from "@party-stack/ontology";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as UnknownRecord)
        : undefined;
}

function parseDate(value: unknown): unknown {
    if (typeof value !== "string") return undefined;
    try {
        return Temporal.PlainDate.from(value);
    } catch {
        return value;
    }
}

function parseTimestamp(value: unknown): unknown {
    if (typeof value !== "string") return undefined;
    try {
        return Temporal.Instant.from(value);
    } catch {
        return value;
    }
}

function convertFoundryStaticValue(value: unknown): unknown {
    const staticValue = asRecord(value);
    switch (staticValue?.type) {
        case "string":
            return staticValue.string;
        case "stringList":
            return asRecord(staticValue.stringList)?.strings;
        case "boolean":
            return staticValue.boolean;
        case "booleanList":
            return asRecord(staticValue.booleanList)?.booleans;
        case "integer":
            return staticValue.integer;
        case "integerList":
            return asRecord(staticValue.integerList)?.integers;
        case "long":
            return staticValue.long;
        case "longList":
            return asRecord(staticValue.longList)?.longs;
        case "double":
            return staticValue.double;
        case "doubleList":
            return asRecord(staticValue.doubleList)?.doubles;
        case "date": {
            const date = asRecord(staticValue.date)?.dateValue ?? staticValue.date;
            return parseDate(date);
        }
        case "dateList": {
            const dates = asRecord(staticValue.dateList)?.dates;
            return Array.isArray(dates)
                ? dates.map(parseDate)
                : undefined;
        }
        case "timestamp":
            return parseTimestamp(staticValue.timestamp);
        case "timestampList": {
            const timestamps = asRecord(staticValue.timestampList)?.timestamps;
            return Array.isArray(timestamps)
                ? timestamps.map(parseTimestamp)
                : undefined;
        }
        case "null":
            return null;
        default:
            return undefined;
    }
}

function unwrapFoundryStaticValue(value: unknown): unknown {
    const prefill = asRecord(value);
    if (!prefill) return undefined;
    if (prefill.type === "staticValue") {
        return convertFoundryStaticValue(prefill.staticValue);
    }
    return convertFoundryStaticValue(prefill);
}

function getValidationPrefill(node: unknown): UnknownRecord | undefined {
    const validation = asRecord(node);
    if (!validation) return undefined;

    const defaultPrefill = getValidationPrefill(validation.defaultValidation);
    if (defaultPrefill) return defaultPrefill;

    const directPrefill = asRecord(validation.prefill);
    if (directPrefill) return directPrefill;

    const displayPrefill = asRecord(asRecord(validation.display)?.prefill);
    if (displayPrefill) return displayPrefill;

    const defaultValue = asRecord(validation.defaultValue);
    if (defaultValue) return defaultValue;

    return asRecord(asRecord(validation.validation)?.defaultValue);
}

function getObjectSetObjectType(objectSet: unknown): string | undefined {
    const startingObjectSet = asRecord(asRecord(asRecord(objectSet)?.objectSet)?.startingObjectSet);
    const base = asRecord(startingObjectSet?.base);
    return startingObjectSet?.type === "base" && typeof base?.objectTypeId === "string"
        ? base.objectTypeId
        : undefined;
}

function unwrapOptional(type: TypeDef): TypeDef {
    return type.kind === "optional" ? unwrapOptional(type.value.type) : type;
}

function getObjectReferenceType(type: TypeDef): string | undefined {
    const unwrapped = unwrapOptional(type);
    if (unwrapped.kind === "objectReference") {
        return unwrapped.value.objectType;
    }
    if (unwrapped.kind === "list") {
        return getObjectReferenceType(unwrapped.value.elementType);
    }
    return undefined;
}

function convertPrefill(
    prefill: UnknownRecord | undefined,
    parameter: ActionParameterDef,
    fieldPath: string[]
): ActionParameterPrefill | undefined {
    if (!prefill) return undefined;

    if (prefill.type === "staticValue") {
        const value = unwrapFoundryStaticValue(prefill);
        return value === undefined
            ? undefined
            : {
                  kind: "literal",
                  value: { fieldPath, value },
              };
    }

    if (prefill.type === "objectParameterPropertyValue") {
        const objectProperty = asRecord(prefill.objectParameterPropertyValue);
        return typeof objectProperty?.parameterId === "string" &&
            typeof objectProperty.propertyTypeId === "string"
            ? {
                  kind: "objectProperty",
                  value: {
                      fieldPath,
                      parameter: objectProperty.parameterId,
                      property: [objectProperty.propertyTypeId],
                  },
              }
            : undefined;
    }

    if (prefill.type === "objectQueryPrefill") {
        const objectSet = asRecord(asRecord(prefill.objectQueryPrefill)?.objectSet);
        const objectType =
            getObjectReferenceType(parameter.type) ??
            getObjectSetObjectType(objectSet);
        return objectSet && objectType
            ? {
                  kind: "foundryObjectQuery",
                  value: {
                      fieldPath,
                      objectType,
                      objectSet,
                  },
              }
            : undefined;
    }

    const literalValue = unwrapFoundryStaticValue(prefill);
    return literalValue === undefined
        ? undefined
        : {
              kind: "literal",
              value: { fieldPath, value: literalValue },
          };
}

function getParameterValidations(actionType: unknown): UnknownRecord | undefined {
    const actionTypeLogic = asRecord(asRecord(actionType)?.actionTypeLogic);
    return asRecord(asRecord(actionTypeLogic?.validation)?.parameterValidations);
}

function getMetadataParameter(actionType: unknown, parameterName: string): UnknownRecord | undefined {
    const metadata = asRecord(asRecord(actionType)?.metadata);
    return asRecord(asRecord(metadata?.parameters)?.[parameterName]);
}

export function convertOmsActionParameterPrefills(
    actionType: unknown,
    parameters: ActionParameterDef[]
): Map<string, ActionParameterPrefill[]> {
    const parameterValidations = getParameterValidations(actionType);
    const result = new Map<string, ActionParameterPrefill[]>();

    for (const parameter of parameters) {
        const prefills: ActionParameterPrefill[] = [];
        const validation = asRecord(parameterValidations?.[parameter.name]);
        const metadataDefault = getValidationPrefill(
            getMetadataParameter(actionType, parameter.name)
        );
        const parameterPrefill = convertPrefill(
            metadataDefault ?? getValidationPrefill(validation),
            parameter,
            []
        );
        if (parameterPrefill) {
            prefills.push(parameterPrefill);
        }

        const structFieldValidations = asRecord(validation?.structFieldValidations);
        for (const [fieldName, fieldValidation] of Object.entries(structFieldValidations ?? {})) {
            const fieldPrefill = convertPrefill(
                getValidationPrefill(fieldValidation),
                parameter,
                fieldName.split(".")
            );
            if (fieldPrefill) {
                prefills.push(fieldPrefill);
            }
        }

        if (prefills.length > 0) {
            result.set(parameter.name, prefills);
        }
    }

    return result;
}
