import { unreachable } from "@bobbyfidz/panic";
import { inhibitOnNull, lambda, LoadedRecordStep, loadOne, objectFieldSpec } from "grafast";
import { GraphQLFieldConfig } from "graphql";
import { context } from "../context.js";
import { NamedGraphQLFieldConfig } from "../utils/NamedGraphQLFieldConfig.js";
import { TypedOntologyObject } from "../utils/TypedOntologyObject.js";
import { GetTypeReference } from "../utils/TypeRegistry.js";
import { getObjectLoader } from "./getObjectLoader.js";
import { LoadedObjectStep } from "./ObjectListStep.js";
import { ObjectSetType } from "./ObjectSetType.js";
import { ObjectType } from "./ObjectType.js";
import type { LinkTypeSideV2, ObjectSet, ObjectTypeV2, OntologyFullMetadata } from "@osdk/foundry.ontologies";

function create(
    path: string,
    getTypeReference: GetTypeReference,
    linkType: LinkTypeSideV2,
    sourceObjectType: ObjectTypeV2,
    ontology: OntologyFullMetadata
): NamedGraphQLFieldConfig {
    const fullPath = `${path}.${linkType.apiName}`;

    const targetObjectType = ontology.objectTypes[linkType.objectTypeApiName]!.objectType;

    let field: GraphQLFieldConfig<any, any, any>;
    if (linkType.cardinality === "ONE") {
        field = objectFieldSpec<LoadedRecordStep<TypedOntologyObject> | LoadedObjectStep>(
            {
                description: `Get the linked ${linkType.displayName}.`,
                // TODO: deprecation
                type: ObjectType.getReferenceByName(getTypeReference, linkType.objectTypeApiName),
                plan: ($object) => {
                    const $foreignKey = $object.get(linkType.foreignKeyPropertyApiName!);
                    return loadOne(inhibitOnNull($foreignKey), context(), getObjectLoader(targetObjectType));
                },
            },
            fullPath
        );
    } else if (linkType.cardinality === "MANY") {
        // We need the reverse link type to get the foreign key API name.
        const foreignKeyPropertyApiName = ontology.objectTypes[linkType.objectTypeApiName]!.linkTypes.find(
            (l) => l.linkTypeRid === linkType.linkTypeRid
        )!.foreignKeyPropertyApiName!;
        field = objectFieldSpec<LoadedRecordStep<TypedOntologyObject> | LoadedObjectStep>(
            {
                description: `Get the linked ${linkType.displayName}.`,
                // TODO: deprecation
                type: ObjectSetType.getReferenceByName(getTypeReference, linkType.objectTypeApiName),
                plan: ($object) => {
                    const $primaryKey = $object.get(sourceObjectType.primaryKey);
                    return lambda(
                        $primaryKey,
                        (primaryKey): ObjectSet => ({
                            type: "filter",
                            objectSet: {
                                type: "base",
                                objectType: linkType.objectTypeApiName,
                            },
                            where: {
                                type: "eq",
                                field: foreignKeyPropertyApiName,
                                value: primaryKey,
                            },
                        }),
                        true
                    );
                },
            },
            fullPath
        );
    } else {
        unreachable(linkType.cardinality);
    }

    return [linkType.apiName, field];
}

export const ObjectLinkField = {
    create,
};
