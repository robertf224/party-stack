import type { QueryFunctionParameterDef, QueryFunctionTypeDef, TypeDef } from "@party-stack/ontology";
import type { QueryDataType, QueryParameterV2, QueryTypeV2 } from "@osdk/foundry.ontologies";

function stringType(): TypeDef {
    return { kind: "string", value: {} };
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

function booleanType(): TypeDef {
    return { kind: "boolean", value: {} };
}

function dateType(): TypeDef {
    return { kind: "date", value: {} };
}

function timestampType(): TypeDef {
    return { kind: "timestamp", value: {} };
}

function attachmentType(type: "attachment" | "media"): TypeDef {
    return {
        kind: "attachment",
        value: { meta: { type } },
    };
}

function maybeOptional(type: TypeDef, required: boolean): TypeDef {
    return required || type.kind === "optional" ? type : { kind: "optional", value: { type } };
}

function convertQueryDataType(type: QueryDataType): TypeDef {
    switch (type.type) {
        case "string":
        case "long":
        case "entrySet":
            return stringType();
        case "integer":
            return integerType();
        case "float":
            return floatType();
        case "double":
            return doubleType();
        case "boolean":
            return booleanType();
        case "date":
            return dateType();
        case "timestamp":
            return timestampType();
        case "attachment":
            return attachmentType("attachment");
        case "mediaReference":
            return attachmentType("media");
        case "object":
            return { kind: "objectReference", value: { objectType: type.objectTypeApiName } };
        case "array":
        case "set":
            return { kind: "list", value: { elementType: convertQueryDataType(type.subType) } };
        case "struct":
            return {
                kind: "struct",
                value: {
                    fields: type.fields.map((field) => ({
                        name: field.name,
                        displayName: field.name,
                        type: convertQueryDataType(field.fieldType),
                    })),
                },
            };
        case "union":
            {
                const nonNullTypes = type.unionTypes.filter((variant) => variant.type !== "null");
                const hasNull = nonNullTypes.length !== type.unionTypes.length;
                const converted =
                    nonNullTypes.length === 0
                        ? { kind: "unknown" as const, value: {} }
                        : nonNullTypes.length === 1
                          ? convertQueryDataType(nonNullTypes[0]!)
                          : {
                                kind: "union" as const,
                                value: {
                                    variants: nonNullTypes.map((variant, index) => ({
                                        name: `variant${index + 1}`,
                                        type: convertQueryDataType(variant),
                                    })),
                                },
                            };
                return maybeOptional(converted, !hasNull);
            }
        case "void":
        case "null":
            return { kind: "unknown", value: {} };
        case "typeReference":
        case "twoDimensionalAggregation":
        case "threeDimensionalAggregation":
        case "objectSet":
        case "interfaceObject":
        case "interfaceObjectSet":
        case "unsupported":
            return { kind: "unknown", value: {} };
    }
}

function convertQueryFunctionParameter(name: string, parameter: QueryParameterV2): QueryFunctionParameterDef {
    return {
        name,
        displayName: name,
        description: parameter.description,
        type: maybeOptional(convertQueryDataType(parameter.dataType), parameter.required),
    };
}

export function convertFoundryMetaQueryFunctionType(query: QueryTypeV2): QueryFunctionTypeDef {
    return {
        name: query.apiName,
        displayName: query.displayName ?? query.apiName,
        description: query.description,
        parameters: Object.entries(query.parameters).map(([name, parameter]) =>
            convertQueryFunctionParameter(name, parameter)
        ),
        returnType: convertQueryDataType(query.output),
    };
}
