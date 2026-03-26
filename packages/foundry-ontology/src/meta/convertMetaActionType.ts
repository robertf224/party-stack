import { Temporal } from "temporal-polyfill";
import type {
    ActionParameterDef,
    ActionTypeDef,
    Expression,
    PropertyAssignment,
    TypeDef,
} from "@party-stack/ontology";
import { toOntologyActionTypeName } from "../utils/actionTypeName.js";
import type {
    ActionLogicRule,
    ActionParameterType,
    ActionTypeFullMetadata,
    LogicRuleArgument,
    OntologyDataType,
    StructFieldArgument,
} from "@osdk/foundry.ontologies";

const FOUNDRY_CURRENT_USER_CONTEXT_PATH = ["userId"];
const FOUNDRY_UUID_PARAMETER_PREFIX = "__uuid_";
const FOUNDRY_NOW_PARAMETER_NAME = "__now";

function maybeOptional(type: TypeDef, required: boolean): TypeDef {
    return required ? type : { kind: "optional", value: { type } };
}

function stringType(): TypeDef {
    return { kind: "string", value: {} };
}

function booleanType(): TypeDef {
    return { kind: "boolean", value: {} };
}

function integerType(): TypeDef {
    return { kind: "integer", value: {} };
}

function floatType(): TypeDef {
    return { kind: "float", value: {} };
}

function doubleType(): TypeDef {
    return { kind: "double", value: {} };
}

function dateType(): TypeDef {
    return { kind: "date", value: {} };
}

function timestampType(): TypeDef {
    return { kind: "timestamp", value: {} };
}

function attachmentType(): TypeDef {
    return { kind: "attachment", value: {} };
}

function createUniqueIdentifierParameterName(linkId: string): string {
    return `${FOUNDRY_UUID_PARAMETER_PREFIX}${encodeURIComponent(linkId)}`;
}

function getUniqueIdentifierLinkIdFromParameterName(parameterName: string): string | undefined {
    if (!parameterName.startsWith(FOUNDRY_UUID_PARAMETER_PREFIX)) {
        return undefined;
    }
    return decodeURIComponent(parameterName.slice(FOUNDRY_UUID_PARAMETER_PREFIX.length));
}

function convertActionParameterType(type: ActionParameterType, required = true): TypeDef {
    const baseType: TypeDef = (() => {
        switch (type.type) {
            case "string":
                return stringType();
            case "boolean":
                return booleanType();
            case "integer":
            case "long":
                return integerType();
            case "double":
                return doubleType();
            case "date":
                return dateType();
            case "timestamp":
                return timestampType();
            case "attachment":
            case "mediaReference":
                return attachmentType();
            case "geohash":
            case "geoshape":
            case "marking":
                return stringType();
            case "vector":
                return {
                    kind: "list",
                    value: { elementType: doubleType() },
                };
            case "array":
                return {
                    kind: "list",
                    value: { elementType: convertActionParameterType(type.subType) },
                };
            case "struct":
                return {
                    kind: "struct",
                    value: {
                        fields: type.fields.map((field, index) => ({
                            name: field.name ?? `field${index + 1}`,
                            displayName: field.name ?? `Field ${index + 1}`,
                            type: convertOntologyDataType(field.fieldType, field.required),
                        })),
                    },
                };
            case "object":
                return {
                    kind: "objectReference",
                    value: { objectType: type.objectTypeApiName },
                };
            case "objectType":
            case "interfaceObject":
            case "objectSet":
                return stringType();
        }
    })();

    return maybeOptional(baseType, required);
}

function convertOntologyDataType(type: OntologyDataType, required = true): TypeDef {
    const baseType: TypeDef = (() => {
        switch (type.type) {
            case "string":
                return stringType();
            case "boolean":
                return booleanType();
            case "byte":
            case "short":
            case "integer":
            case "long":
                return integerType();
            case "float":
                return floatType();
            case "double":
            case "decimal":
                return doubleType();
            case "date":
                return dateType();
            case "timestamp":
                return timestampType();
            case "binary":
            case "mediaReference":
                return attachmentType();
            case "array":
            case "set":
                return {
                    kind: "list",
                    value: { elementType: convertOntologyDataType(type.itemType) },
                };
            case "struct":
                return {
                    kind: "struct",
                    value: {
                        fields: type.fields.map((field, index) => ({
                            name: field.name ?? `field${index + 1}`,
                            displayName: field.name ?? `Field ${index + 1}`,
                            type: convertOntologyDataType(field.fieldType, field.required),
                        })),
                    },
                };
            default:
                return stringType();
        }
    })();

    return maybeOptional(baseType, required);
}

function collectRuleArguments(rule: ActionLogicRule): Array<LogicRuleArgument | StructFieldArgument> {
    switch (rule.type) {
        case "createObject":
        case "modifyObject":
            return [
                ...Object.values(rule.propertyArguments),
                ...Object.values(rule.structPropertyArguments).flatMap((fields) => Object.values(fields)),
            ];
        default:
            return [];
    }
}

function createSyntheticParameters(actionType: ActionTypeFullMetadata): {
    parameters: ActionParameterDef[];
    uniqueIdentifierParametersByLinkId: Map<string, string>;
    nowParameterName?: string;
} {
    const uniqueIdentifierParametersByLinkId = new Map<string, string>();
    let nowParameterName: string | undefined;

    for (const rule of actionType.fullLogicRules) {
        for (const argument of collectRuleArguments(rule)) {
            if (argument.type === "uniqueIdentifier" && argument.linkId) {
                if (!uniqueIdentifierParametersByLinkId.has(argument.linkId)) {
                    uniqueIdentifierParametersByLinkId.set(
                        argument.linkId,
                        createUniqueIdentifierParameterName(argument.linkId)
                    );
                }
            }
            if (argument.type === "currentTime" && !nowParameterName) {
                nowParameterName = FOUNDRY_NOW_PARAMETER_NAME;
            }
        }
    }

    const parameters: ActionParameterDef[] = Array.from(uniqueIdentifierParametersByLinkId.values()).map(
        (name, index): ActionParameterDef => ({
            name,
            displayName: `Generated UUID ${index + 1}`,
            type: { kind: "string", value: {} },
            defaultValue: {
                kind: "functionCall",
                value: { kind: "uuid", value: {} },
            },
        })
    );

    if (nowParameterName) {
        parameters.push({
            name: nowParameterName,
            displayName: "Current time",
            type: { kind: "timestamp", value: {} },
            defaultValue: {
                kind: "functionCall",
                value: { kind: "now", value: {} },
            },
        });
    }

    return { parameters, uniqueIdentifierParametersByLinkId, nowParameterName };
}

export function getFoundryActionOverrideParameterMapping(actionType: ActionTypeDef): {
    uuidByParameterName: Map<string, string>;
    nowParameterName?: string;
} {
    const uuidByParameterName = new Map<string, string>();
    let nowParameterName: string | undefined;

    for (const parameter of actionType.parameters) {
        if (parameter.defaultValue?.kind !== "functionCall") {
            continue;
        }
        switch (parameter.defaultValue.value.kind) {
            case "uuid": {
                const linkId = getUniqueIdentifierLinkIdFromParameterName(parameter.name);
                if (linkId) {
                    uuidByParameterName.set(parameter.name, linkId);
                }
                break;
            }
            case "now":
                nowParameterName ??= parameter.name;
                break;
        }
    }

    return { uuidByParameterName, nowParameterName };
}

function valueReference(path: string[]): Expression {
    return {
        kind: "valueReference",
        value: { path },
    };
}

// TODO: This uses regex heuristics to infer the type of static literal values without
// knowing the target property type. We should eventually resolve the target property's
// TypeDef from the object type definition so we decode accurately instead of guessing
// from the string format.
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GEO_POINT_RE = /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/;

function decodeLiteralValue(value: unknown): unknown {
    if (typeof value !== "string") {
        return value;
    }

    if (ISO_TIMESTAMP_RE.test(value)) {
        try {
            return Temporal.Instant.from(value);
        } catch {
            return value;
        }
    }

    if (ISO_DATE_RE.test(value)) {
        try {
            return Temporal.PlainDate.from(value);
        } catch {
            return value;
        }
    }

    const geoMatch = GEO_POINT_RE.exec(value);
    if (geoMatch) {
        return { lat: Number(geoMatch[1]), lon: Number(geoMatch[2]) };
    }

    return value;
}

function convertLogicRuleArgument(
    argument: LogicRuleArgument | StructFieldArgument,
    syntheticParameters: {
        uniqueIdentifierParametersByLinkId: Map<string, string>;
        nowParameterName?: string;
    }
): Expression {
    switch (argument.type) {
        case "parameterId":
            return valueReference([argument.parameterId]);
        case "objectParameterPropertyValue":
            return valueReference([argument.parameterId, argument.propertyTypeApiName]);
        case "structParameterFieldValue":
        case "structListParameterFieldValue":
            return valueReference([argument.parameterId, argument.structParameterFieldApiName]);
        case "uniqueIdentifier": {
            const parameterName = argument.linkId
                ? syntheticParameters.uniqueIdentifierParametersByLinkId.get(argument.linkId)
                : undefined;
            return parameterName
                ? valueReference([parameterName])
                : {
                      kind: "functionCall",
                      value: { kind: "uuid", value: {} },
                  };
        }
        case "currentTime":
            return syntheticParameters.nowParameterName
                ? valueReference([syntheticParameters.nowParameterName])
                : {
                      kind: "functionCall",
                      value: { kind: "now", value: {} },
                  };
        case "staticValue":
            return {
                kind: "literal",
                value: { value: decodeLiteralValue(argument.value) },
            };
        case "currentUser":
            return {
                kind: "contextReference",
                value: { path: FOUNDRY_CURRENT_USER_CONTEXT_PATH },
            };
        default:
            throw new Error(`Unsupported Foundry action argument "${argument.type}".`);
    }
}

function convertAssignments(
    rule: Extract<ActionLogicRule, { type: "createObject" | "modifyObject" }>,
    syntheticParameters: {
        uniqueIdentifierParametersByLinkId: Map<string, string>;
        nowParameterName?: string;
    }
): PropertyAssignment[] {
    return [
        ...Object.entries(rule.propertyArguments).map(([property, argument]) => ({
            property: [property],
            value: convertLogicRuleArgument(argument, syntheticParameters),
        })),
        ...Object.entries(rule.structPropertyArguments).flatMap(([property, fields]) =>
            Object.entries(fields).map(([field, argument]) => ({
                property: [property, field],
                value: convertLogicRuleArgument(argument, syntheticParameters),
            }))
        ),
    ];
}

function convertLogicStep(
    rule: ActionLogicRule,
    syntheticParameters: {
        uniqueIdentifierParametersByLinkId: Map<string, string>;
        nowParameterName?: string;
    }
): ActionTypeDef["logic"][number] | null {
    switch (rule.type) {
        case "createObject":
            return {
                kind: "createObject",
                value: {
                    objectType: rule.objectTypeApiName,
                    values: convertAssignments(rule, syntheticParameters),
                },
            };
        case "modifyObject":
            return {
                kind: "updateObject",
                value: {
                    object: {
                        path: [rule.objectToModify],
                    },
                    values: convertAssignments(rule, syntheticParameters),
                },
            };
        case "deleteObject":
            return {
                kind: "deleteObject",
                value: {
                    object: {
                        path: [rule.objectToDelete],
                    },
                },
            };
        default:
            return null;
    }
}

export function convertFoundryMetaActionType(actionType: ActionTypeFullMetadata): ActionTypeDef {
    const syntheticParameters = createSyntheticParameters(actionType);
    const fullLogicRules = actionType.fullLogicRules
        .map((rule) => convertLogicStep(rule, syntheticParameters))
        .filter((rule): rule is NonNullable<typeof rule> => rule !== null);

    return {
        name: toOntologyActionTypeName(actionType.actionType.apiName),
        displayName: actionType.actionType.displayName ?? actionType.actionType.apiName,
        description: actionType.actionType.description,
        deprecated:
            actionType.actionType.status === "DEPRECATED" ? { message: "Deprecated in Foundry." } : undefined,
        parameters: [
            ...Object.entries(actionType.actionType.parameters).map(
                ([name, parameter]): ActionParameterDef => ({
                    name,
                    displayName: parameter.displayName ?? name,
                    type: convertActionParameterType(parameter.dataType, parameter.required),
                    description: parameter.description,
                })
            ),
            ...syntheticParameters.parameters,
        ],
        logic: fullLogicRules,
    };
}
