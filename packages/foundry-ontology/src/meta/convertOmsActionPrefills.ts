import { Temporal } from "temporal-polyfill";
import type {
    ActionParameterDef,
    Expression,
    StringConstraint,
    StringSuggestion,
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

function convertPrefill(
    prefill: UnknownRecord | undefined
): Expression | undefined {
    if (!prefill) return undefined;

    if (prefill.type === "staticValue") {
        const value = unwrapFoundryStaticValue(prefill);
        return value === undefined
            ? undefined
            : {
                  kind: "literal",
                  value: { value },
              };
    }

    if (prefill.type === "objectParameterPropertyValue") {
        const objectProperty = asRecord(prefill.objectParameterPropertyValue);
        return typeof objectProperty?.parameterId === "string" &&
            typeof objectProperty.propertyTypeId === "string"
            ? {
                  kind: "valueReference",
                  value: {
                      path: [
                          objectProperty.parameterId,
                          objectProperty.propertyTypeId,
                      ],
                  },
              }
            : undefined;
    }

    const literalValue = unwrapFoundryStaticValue(prefill);
    return literalValue === undefined
        ? undefined
        : {
              kind: "literal",
              value: { value: literalValue },
          };
}

function getParameterValidations(actionType: unknown): UnknownRecord | undefined {
    const actionTypeLogic = asRecord(asRecord(actionType)?.actionTypeLogic);
    return asRecord(asRecord(actionTypeLogic?.validation)?.parameterValidations);
}

function getOmsActionParameterAllowedValues(
    actionType: unknown,
    parameterName: string
): UnknownRecord | undefined {
    const parameterValidation = asRecord(
        getParameterValidations(actionType)?.[parameterName]
    );
    const defaultValidation = asRecord(
        parameterValidation?.defaultValidation
    );
    return asRecord(
        asRecord(defaultValidation?.validation)?.allowedValues
    );
}

function getOmsOneOf(
    allowedValues: UnknownRecord | undefined
): {
    options: StringSuggestion[];
    otherValuesAllowed: boolean;
} | undefined {
    if (allowedValues?.type !== "oneOf") return undefined;
    const oneOfOrEmpty = asRecord(allowedValues.oneOf);
    if (oneOfOrEmpty?.type !== "oneOf") return undefined;
    const oneOf = asRecord(oneOfOrEmpty.oneOf);
    if (!Array.isArray(oneOf?.labelledValues)) return undefined;

    const options = oneOf.labelledValues.flatMap((entry) => {
        const labelledValue = asRecord(entry);
        const value = unwrapFoundryStaticValue(labelledValue?.value);
        return typeof value === "string"
            ? [
                  {
                      value,
                      label:
                          typeof labelledValue?.label === "string"
                              ? labelledValue.label
                              : undefined,
                  },
              ]
            : [];
    });
    return options.length > 0
        ? {
              options,
              otherValuesAllowed:
                  asRecord(oneOf.otherValueAllowed)?.allowed === true,
          }
        : undefined;
}

export function convertOmsActionParameterStringConstraint(
    actionType: unknown,
    parameterName: string
): StringConstraint | undefined {
    const allowedValues = getOmsActionParameterAllowedValues(
        actionType,
        parameterName
    );

    if (allowedValues?.type === "oneOf") {
        const oneOf = getOmsOneOf(allowedValues);
        return oneOf && !oneOf.otherValuesAllowed
            ? {
                  kind: "enum",
                  value: { options: oneOf.options },
              }
            : undefined;
    }

    if (allowedValues?.type === "text") {
        const textOrEmpty = asRecord(allowedValues.text);
        if (textOrEmpty?.type !== "text") return undefined;
        const text = asRecord(textOrEmpty.text);
        const regexValue = text?.regex;
        const regex =
            typeof regexValue === "string"
                ? regexValue
                : asRecord(regexValue)?.regex;
        return typeof regex === "string" && regex.length > 0
            ? {
                  kind: "regex",
                  value: { regex },
              }
            : undefined;
    }

    return undefined;
}

export function convertOmsActionParameterStringSuggestions(
    actionType: unknown,
    parameterName: string
): StringSuggestion[] | undefined {
    const oneOf = getOmsOneOf(
        getOmsActionParameterAllowedValues(
            actionType,
            parameterName
        )
    );
    return oneOf?.otherValuesAllowed
        ? oneOf.options
        : undefined;
}

function getMetadataParameter(actionType: unknown, parameterName: string): UnknownRecord | undefined {
    const metadata = asRecord(asRecord(actionType)?.metadata);
    return asRecord(asRecord(metadata?.parameters)?.[parameterName]);
}

export function convertOmsActionParameterDefaults(
    actionType: unknown,
    parameters: ActionParameterDef[]
): Map<string, Expression> {
    const parameterValidations = getParameterValidations(actionType);
    const result = new Map<string, Expression>();

    for (const parameter of parameters) {
        const validation = asRecord(parameterValidations?.[parameter.name]);
        const metadataDefault = getValidationPrefill(
            getMetadataParameter(actionType, parameter.name)
        );
        const parameterDefault = convertPrefill(
            metadataDefault ?? getValidationPrefill(validation)
        );
        if (parameterDefault) {
            result.set(parameter.name, parameterDefault);
        }
    }

    return result;
}
