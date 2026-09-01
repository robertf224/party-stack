import { Temporal } from "temporal-polyfill";
import type {
    ActionParameterDef,
    Expression,
    ObjectQueryPredicate,
    StringConstraint,
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

function unwrapOptional(type: TypeDef): TypeDef {
    return type.kind === "optional" ? unwrapOptional(type.value.type) : type;
}

function getObjectReferenceType(type: TypeDef): string | undefined {
    const unwrapped = unwrapOptional(type);
    if (unwrapped.kind === "objectReference") {
        return unwrapped.value.objectType;
    }
    return undefined;
}

function conditionValueToValue(
    value: unknown,
    conditionValues: UnknownRecord | undefined
): unknown {
    const conditionValue = asRecord(value);
    if (!conditionValue) return undefined;
    if (conditionValue.type === "staticValue") {
        return unwrapFoundryStaticValue(conditionValue.staticValue);
    }
    if (conditionValue.type === "resolved") {
        return asRecord(conditionValue.resolved)?.value;
    }
    if (conditionValue.type === "unresolved") {
        const unresolved = asRecord(conditionValue.unresolved);
        const parameterId = unresolved?.parameterId;
        const resolved =
            typeof parameterId === "string"
                ? conditionValueToValue(
                      conditionValues?.[parameterId],
                      conditionValues
                  )
                : undefined;
        return resolved ??
            unwrapFoundryStaticValue(unresolved?.defaultValue) ??
            unresolved?.defaultValue;
    }
    return undefined;
}

function parameterizedValues(
    values: unknown,
    conditionValues: UnknownRecord | undefined
): unknown[] | undefined {
    if (!Array.isArray(values)) return undefined;
    const resolved = values.map((value) =>
        conditionValueToValue(value, conditionValues)
    );
    if (resolved.some((value) => value === undefined)) return undefined;
    const converted = resolved.flatMap((value) =>
        Array.isArray(value)
            ? (value as unknown[])
            : [value]
    );
    return converted.length > 0 ? converted : undefined;
}

function equalsPredicate(property: string, values: unknown[]): ObjectQueryPredicate | null {
    if (values.length === 0) return null;
    return values.length === 1
        ? {
              kind: "eq",
              value: {
                  property: [property],
                  value: values[0],
              },
          }
        : {
              kind: "in",
              value: {
                  property: [property],
                  values,
              },
          };
}

function convertObjectSetFilter(
    filter: unknown,
    conditionValues: UnknownRecord | undefined
): ObjectQueryPredicate | null {
    const value = asRecord(filter);
    if (!value) return null;

    switch (value.type) {
        case "exactMatch": {
            const exactMatch = asRecord(value.exactMatch);
            if (
                typeof exactMatch?.propertyId !== "string" ||
                !Array.isArray(exactMatch.terms)
            ) {
                return null;
            }
            const terms = exactMatch.terms.map(unwrapFoundryStaticValue);
            return terms.some((term) => term === undefined)
                ? null
                : equalsPredicate(exactMatch.propertyId, terms);
        }
        case "parameterizedExactMatch": {
            const exactMatch = asRecord(value.parameterizedExactMatch);
            if (typeof exactMatch?.propertyId !== "string") return null;
            const values = parameterizedValues(exactMatch.terms, conditionValues);
            return values
                ? equalsPredicate(exactMatch.propertyId, values)
                : null;
        }
        case "range": {
            const range = asRecord(value.range);
            if (typeof range?.propertyId !== "string") return null;
            const bounds = Object.fromEntries(
                (["lt", "lte", "gt", "gte"] as const).flatMap((operator) => {
                    const bound = unwrapFoundryStaticValue(range[operator]);
                    return bound === undefined ? [] : [[operator, bound]];
                })
            );
            return Object.keys(bounds).length > 0
                ? {
                      kind: "range",
                      value: {
                          property: [range.propertyId],
                          ...bounds,
                      },
                  }
                : null;
        }
        case "and":
        case "or": {
            const filters = asRecord(value[value.type])?.filters;
            if (!Array.isArray(filters)) return null;
            const predicates = filters.map((child) =>
                convertObjectSetFilter(child, conditionValues)
            );
            return predicates.some((predicate) => predicate === null)
                ? null
                : {
                      kind: value.type,
                      value: {
                          predicates: predicates as ObjectQueryPredicate[],
                      },
                  };
        }
        case "not": {
            const predicate = convertObjectSetFilter(
                asRecord(value.not)?.filter,
                conditionValues
            );
            return predicate
                ? {
                      kind: "not",
                      value: { predicate },
                  }
                : null;
        }
        default:
            return null;
    }
}

function convertObjectSet(
    objectSet: UnknownRecord,
    expectedObjectTypeId: string
): ObjectQueryPredicate | null | undefined {
    const dynamicObjectSet = asRecord(objectSet.objectSet);
    const startingObjectSet = asRecord(dynamicObjectSet?.startingObjectSet);
    const base = asRecord(startingObjectSet?.base);
    if (
        startingObjectSet?.type !== "base" ||
        typeof base?.objectTypeId !== "string" ||
        base.objectTypeId !== expectedObjectTypeId
    ) {
        return null;
    }
    const transforms = dynamicObjectSet?.transforms;
    const conditionValues = asRecord(objectSet.conditionValues);
    if (!Array.isArray(transforms)) return null;
    if (transforms.length === 0) return undefined;

    const predicates: ObjectQueryPredicate[] = [];
    for (const transform of transforms) {
        const value = asRecord(transform);
        if (value?.type !== "propertyFilter") return null;
        const predicate = convertObjectSetFilter(
            value.propertyFilter,
            conditionValues
        );
        if (!predicate) return null;
        predicates.push(predicate);
    }
    return predicates.length === 1
        ? predicates[0]
        : {
              kind: "and",
              value: { predicates },
          };
}

function convertPrefill(
    prefill: UnknownRecord | undefined,
    parameter: ActionParameterDef,
    objectTypeId: string | undefined
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

    if (prefill.type === "objectQueryPrefill") {
        const objectSet = asRecord(asRecord(prefill.objectQueryPrefill)?.objectSet);
        const objectType = getObjectReferenceType(parameter.type);
        if (!objectSet || !objectType || !objectTypeId) return undefined;
        const where = convertObjectSet(objectSet, objectTypeId);
        return where === null
            ? undefined
            : {
                  kind: "objectQuery",
                  value: {
                      objectType,
                      ...(where ? { where } : {}),
                  },
              };
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

export function convertOmsActionParameterStringConstraint(
    actionType: unknown,
    parameterName: string
): StringConstraint | undefined {
    const parameterValidation = asRecord(
        getParameterValidations(actionType)?.[parameterName]
    );
    const defaultValidation = asRecord(
        parameterValidation?.defaultValidation
    );
    const validation = asRecord(defaultValidation?.validation);
    const allowedValues = asRecord(validation?.allowedValues);

    if (allowedValues?.type === "oneOf") {
        const oneOfOrEmpty = asRecord(allowedValues.oneOf);
        if (oneOfOrEmpty?.type !== "oneOf") return undefined;
        const oneOf = asRecord(oneOfOrEmpty.oneOf);
        if (
            asRecord(oneOf?.otherValueAllowed)?.allowed === true ||
            !Array.isArray(oneOf?.labelledValues)
        ) {
            return undefined;
        }
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
                  kind: "enum",
                  value: { options },
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

function getMetadataParameter(actionType: unknown, parameterName: string): UnknownRecord | undefined {
    const metadata = asRecord(asRecord(actionType)?.metadata);
    return asRecord(asRecord(metadata?.parameters)?.[parameterName]);
}

export function convertOmsActionParameterDefaults(
    actionType: unknown,
    parameters: ActionParameterDef[],
    objectTypeIdsByParameter: ReadonlyMap<string, string>
): Map<string, Expression> {
    const parameterValidations = getParameterValidations(actionType);
    const result = new Map<string, Expression>();

    for (const parameter of parameters) {
        const validation = asRecord(parameterValidations?.[parameter.name]);
        const metadataDefault = getValidationPrefill(
            getMetadataParameter(actionType, parameter.name)
        );
        const parameterDefault =
            convertPrefill(
                metadataDefault ?? getValidationPrefill(validation),
                parameter,
                objectTypeIdsByParameter.get(parameter.name)
            );
        if (parameterDefault) {
            result.set(parameter.name, parameterDefault);
        }
    }

    return result;
}
