import { ObjectSet, ObjectTypeV2, PropertyApiName } from "@osdk/foundry.ontologies";
import { Maybe, objectFieldSpec, Step } from "grafast";
import { GraphQLString } from "graphql";
import { GraphQLInt } from "graphql";
import { NamedGraphQLFieldConfig } from "../utils/NamedGraphQLFieldConfig.js";
import { GetTypeReference } from "../utils/TypeRegistry.js";
import { objectListConnection } from "./ObjectListStep.js";
import { ObjectListTypes } from "./ObjectListTypes.js";

function create(
    path: string,
    getTypeReference: GetTypeReference,
    objectType: ObjectTypeV2
): NamedGraphQLFieldConfig {
    const field = objectFieldSpec<Step<ObjectSet>, ReturnType<typeof objectListConnection>>(
        {
            description: `A list of ${objectType.pluralDisplayName}.`,
            // TODO: args
            args: {
                after: {
                    type: GraphQLString,
                },
                first: {
                    type: GraphQLInt,
                },
                orderBy: {
                    type: ObjectListTypes.getOrderByTypeReference(getTypeReference, objectType),
                },
            },
            type: ObjectListTypes.getPageTypeReference(getTypeReference, objectType),
            plan: ($objectSet, $args) =>
                objectListConnection(
                    $objectSet,
                    $args.getRaw() as Step<{
                        first: Maybe<number>;
                        after: Maybe<string>;
                        orderBy: Maybe<{
                            fields: { field: PropertyApiName; direction: "asc" | "desc" }[];
                        }>;
                    }>
                ),
        },
        `${path}.list`
    );

    return ["list", field];
}

export const ObjectListField = {
    create,
};
