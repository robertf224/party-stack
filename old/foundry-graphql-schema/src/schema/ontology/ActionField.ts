import { Result } from "@bobbyfidz/result";
import { ActionParameterType, Actions, ActionTypeV2, OntologyFullMetadata } from "@osdk/foundry.ontologies";
import { camelCase } from "change-case";
import { objectFieldSpec, sideEffect, Step } from "grafast";
import {
    GraphQLArgumentConfig,
    GraphQLBoolean,
    GraphQLFloat,
    GraphQLInputType,
    GraphQLInt,
    GraphQLString,
} from "graphql";
import { context } from "../context.js";
import { NamedGraphQLFieldConfig } from "../utils/NamedGraphQLFieldConfig.js";
import { Schemas } from "../utils/Schemas.js";
import { GetTypeReference } from "../utils/TypeRegistry.js";
import { ObjectArgumentType } from "./ObjectArgumentType.js";

function getArgumentType(
    type: ActionParameterType,
    ontology: OntologyFullMetadata
): Result<GraphQLInputType> {
    switch (type.type) {
        case "array":
            return Result.map(getArgumentType(type.subType, ontology), (subType) => Schemas.list(subType));
        case "struct":
            return Result.err(new Error("Struct type not supported."));
        case "string":
            return Result.ok(GraphQLString);
        case "integer":
            return Result.ok(GraphQLInt);
        case "long":
            return Result.err(new Error("Long type not supported."));
        case "boolean":
            return Result.ok(GraphQLBoolean);
        case "double":
            return Result.ok(GraphQLFloat);
        case "date":
            return Result.err(new Error("Date type not supported."));
        case "timestamp":
            return Result.err(new Error("Timestamp type not supported."));
        case "geohash":
            return Result.err(new Error("Geohash type not supported."));
        case "geoshape":
            return Result.err(new Error("Geoshape type not supported."));
        case "attachment":
            return Result.err(new Error("Attachment type not supported."));
        case "mediaReference":
            return Result.err(new Error("MediaReference type not supported."));
        case "marking":
            return Result.err(new Error("Marking type not supported."));
        case "vector":
            return Result.err(new Error("Vector type not supported."));
        case "objectType":
            return Result.err(new Error("ObjectType type not supported."));
        case "object": {
            const objectType = ontology.objectTypes[type.objectTypeApiName]!.objectType;
            return Result.ok(ObjectArgumentType.get(objectType));
        }
        case "interfaceObject":
            return Result.err(new Error("InterfaceObject type not supported."));
        case "objectSet":
            return Result.err(new Error("ObjectSet type not supported."));
        default:
            return Result.err(new Error(`Unknown Action parameter type.`));
    }
}

function create(
    getTypeReference: GetTypeReference,
    actionType: ActionTypeV2,
    ontology: OntologyFullMetadata
): Result<NamedGraphQLFieldConfig> {
    const fieldName = camelCase(actionType.apiName);

    const argTypeResults = Object.fromEntries(
        Object.entries(actionType.parameters).map(([parameterApiName, parameter]) => [
            parameterApiName,
            getArgumentType(parameter.dataType, ontology),
        ])
    );
    const invalidArgTypes = Object.entries(argTypeResults).filter(([, result]) => Result.isErr(result));
    if (invalidArgTypes.length > 0) {
        return Result.err(
            new Error(
                invalidArgTypes
                    .map(([parameterApiName, result]) => `${parameterApiName}: ${result.error}`)
                    .join("\n")
            )
        );
    }
    const argTypes = Object.fromEntries(
        Object.entries(argTypeResults).map(([parameterApiName, result]) => [
            parameterApiName,
            Result.unwrap(result),
        ])
    );

    const field = objectFieldSpec<Step, Step>(
        {
            description: actionType.description,
            deprecationReason:
                actionType.status === "DEPRECATED" ? "This Action type is deprecated." : undefined,
            args: Object.fromEntries(
                Object.entries(actionType.parameters).map(
                    ([parameterApiName, parameter]) =>
                        [
                            parameterApiName,
                            {
                                description: parameter.description,
                                type: parameter.required
                                    ? Schemas.required(argTypes[parameterApiName]!)
                                    : argTypes[parameterApiName]!,
                            },
                        ] as [string, GraphQLArgumentConfig]
                )
            ),
            // TODO: return real stuff here.
            type: GraphQLBoolean,
            plan: (_$mutation, $args) => {
                return sideEffect(
                    [$args.getRaw() as Step<Record<string, unknown>>, context()],
                    async ([args, context]) => {
                        const result = await Actions.apply(
                            context.client,
                            context.ontologyRid,
                            actionType.apiName,
                            {
                                options: {
                                    mode: "VALIDATE_AND_EXECUTE",
                                    returnEdits: "ALL_V2_WITH_DELETIONS",
                                },
                                parameters: args,
                            }
                        );
                        return result.validation?.result === "VALID";
                    }
                );
            },
        },
        `Mutation.${fieldName}`
    );

    return Result.ok([fieldName, field]);
}

export const ActionField = {
    create,
};
