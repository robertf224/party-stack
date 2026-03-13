import { ObjectSet, ObjectTypeV2 } from "@osdk/foundry.ontologies";
import { camelCase } from "change-case";
import { lambda, Step } from "grafast";
import { objectFieldSpec } from "grafast";
import { NamedGraphQLFieldConfig } from "../utils/NamedGraphQLFieldConfig.js";
import { GetTypeReference } from "../utils/TypeRegistry.js";
import { ObjectSetFilter, ObjectSetFilterType } from "./ObjectSetFilterType.js";
import { ObjectSetType } from "./ObjectSetType.js";

function create(getTypeReference: GetTypeReference, objectType: ObjectTypeV2): NamedGraphQLFieldConfig {
    const fieldName = `${camelCase(objectType.apiName)}Search`;

    const field = objectFieldSpec<Step, Step<ObjectSet>>(
        {
            description: `Search or list ${objectType.pluralDisplayName}.`,
            // TODO: deprecation
            args: {
                where: {
                    description: `Filter for the set of ${objectType.pluralDisplayName}.`,
                    type: ObjectSetFilterType.getReference(getTypeReference, objectType),
                },
            },
            type: ObjectSetType.getReference(getTypeReference, objectType),
            plan: (_$query, $args) => {
                return lambda(
                    $args.getRaw(),
                    (args: { where: ObjectSetFilter }) => {
                        let objectSet: ObjectSet = {
                            type: "base",
                            objectType: objectType.apiName,
                        };
                        if (args.where) {
                            const filter = ObjectSetFilterType.toObjectSetFilter(objectType, args.where);
                            if (filter) {
                                objectSet = { type: "filter", objectSet, where: filter };
                            }
                        }
                        return objectSet;
                    },
                    true
                );
            },
        },
        `Query.${fieldName}`
    );

    return [fieldName, field];
}

export const ObjectSearchQueryField = {
    create,
};
