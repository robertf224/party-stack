import { Temporal } from "temporal-polyfill";
import type {
    ActionParameterDef,
    Expression,
    StringConstraint,
    StringSuggestion,
} from "@party-stack/ontology";
import type { ActionTypeOmsMetadata } from "./loadActionTypeOmsMetadata.js";
import type {
    AllowedParameterValues,
    ParameterPrefill,
    StaticValue,
} from "@osdk/client.unstable";

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

function convertFoundryStaticValue(
    staticValue: StaticValue
): unknown {
    switch (staticValue.type) {
        case "string":
            return staticValue.string;
        case "stringList":
            return staticValue.stringList.strings;
        case "boolean":
            return staticValue.boolean;
        case "booleanList":
            return staticValue.booleanList.booleans;
        case "integer":
            return staticValue.integer;
        case "integerList":
            return staticValue.integerList.integers;
        case "long":
            return staticValue.long;
        case "longList":
            return staticValue.longList.longs;
        case "double":
            return staticValue.double;
        case "doubleList":
            return staticValue.doubleList.doubles;
        case "date":
            return parseDate(staticValue.date.dateValue);
        case "dateList":
            return staticValue.dateList.dates.map(parseDate);
        case "timestamp":
            return parseTimestamp(staticValue.timestamp);
        case "timestampList":
            return staticValue.timestampList.timestamps.map(
                parseTimestamp
            );
        case "null":
            return null;
        default:
            return undefined;
    }
}

function convertDefaultValue(
    propertyApiNamesByParameter: ReadonlyMap<
        string,
        ReadonlyMap<string, string>
    >,
    defaultValue: ParameterPrefill | undefined
): Expression | undefined {
    if (!defaultValue) return undefined;

    if (defaultValue.type === "staticValue") {
        const value = convertFoundryStaticValue(
            defaultValue.staticValue
        );
        return value === undefined
            ? undefined
            : {
                  kind: "literal",
                  value: { value },
              };
    }

    if (
        defaultValue.type ===
        "objectParameterPropertyValue"
    ) {
        const objectProperty =
            defaultValue.objectParameterPropertyValue;
        const parameterName = objectProperty.parameterId;
        const propertyApiName =
            propertyApiNamesByParameter
                .get(parameterName)
                ?.get(objectProperty.propertyTypeId);
        if (!propertyApiName) return undefined;

        return {
            kind: "getAt",
            value: {
                source: {
                    kind: "objectLookup",
                    value: {
                        reference: {
                            kind: "inputReference",
                            value: {
                                name: parameterName,
                            },
                        },
                    },
                },
                path: [propertyApiName],
            },
        };
    }

    return undefined;
}

function getOmsActionParameterAllowedValues(
    actionType: ActionTypeOmsMetadata | undefined,
    parameterName: string,
    fieldName?: string
): AllowedParameterValues | undefined {
    const parameterValidation = actionType?.actionType.actionTypeLogic.validation
        .parameterValidations[parameterName];
    const validation = fieldName === undefined
        ? parameterValidation
        : parameterValidation?.structFieldValidations?.[fieldName];
    return validation?.defaultValidation.validation?.allowedValues;
}

function getOmsOneOf(
    allowedValues: AllowedParameterValues | undefined
): {
    options: StringSuggestion[];
    otherValuesAllowed: boolean;
} | undefined {
    if (allowedValues?.type !== "oneOf") return undefined;
    if (allowedValues.oneOf.type !== "oneOf") {
        return undefined;
    }
    const oneOf = allowedValues.oneOf.oneOf;

    const options = oneOf.labelledValues.flatMap((entry) => {
        const value = convertFoundryStaticValue(entry.value);
        return typeof value === "string"
            ? [
                  {
                      value,
                      label: entry.label,
                  },
              ]
            : [];
    });
    return options.length > 0
        ? {
              options,
              otherValuesAllowed:
                  oneOf.otherValueAllowed.allowed,
          }
        : undefined;
}

export function convertOmsActionParameterStringConstraint(
    actionType: ActionTypeOmsMetadata | undefined,
    parameterName: string,
    fieldName?: string
): StringConstraint | undefined {
    const allowedValues = getOmsActionParameterAllowedValues(
        actionType,
        parameterName,
        fieldName
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
        if (allowedValues.text.type !== "text") {
            return undefined;
        }
        const regex = allowedValues.text.text.regex?.regex;
        return regex
            ? {
                  kind: "regex",
                  value: { regex },
              }
            : undefined;
    }

    return undefined;
}

export function convertOmsActionParameterStringSuggestions(
    actionType: ActionTypeOmsMetadata | undefined,
    parameterName: string,
    fieldName?: string
): StringSuggestion[] | undefined {
    const oneOf = getOmsOneOf(
        getOmsActionParameterAllowedValues(
            actionType,
            parameterName,
            fieldName
        )
    );
    return oneOf?.otherValuesAllowed
        ? oneOf.options
        : undefined;
}

export function convertOmsActionParameterDefaults(
    actionType: ActionTypeOmsMetadata | undefined,
    parameters: ActionParameterDef[]
): Map<string, Expression> {
    const result = new Map<string, Expression>();
    if (!actionType) return result;

    const parameterValidations =
        actionType.actionType.actionTypeLogic.validation
            .parameterValidations;

    for (const parameter of parameters) {
        const defaultValue =
            parameterValidations?.[parameter.name]
                ?.defaultValidation.display.prefill ??
            undefined;
        const parameterDefault = convertDefaultValue(
            actionType.propertyApiNamesByParameter,
            defaultValue
        );
        if (parameterDefault) {
            result.set(parameter.name, parameterDefault);
        }
    }

    return result;
}
