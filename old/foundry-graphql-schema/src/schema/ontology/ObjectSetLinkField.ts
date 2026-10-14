import { lambda, objectFieldSpec, Step } from "grafast";
import { NamedGraphQLFieldConfig } from "../utils/NamedGraphQLFieldConfig.js";
import { GetTypeReference } from "../utils/TypeRegistry.js";
import { ObjectSetType } from "./ObjectSetType.js";
import type { LinkTypeSideV2, ObjectSet } from "@osdk/foundry.ontologies";

function create(
    path: string,
    getTypeReference: GetTypeReference,
    linkType: LinkTypeSideV2
): NamedGraphQLFieldConfig {
    const fieldName = linkType.cardinality === "MANY" ? linkType.apiName : `${linkType.apiName}Set`;

    const field = objectFieldSpec<Step<ObjectSet>>(
        {
            description: `Get the linked ${linkType.displayName} set.`,
            // TODO: deprecation
            type: ObjectSetType.getReferenceByName(getTypeReference, linkType.objectTypeApiName),
            plan: ($objectSet) => {
                return lambda(
                    $objectSet,
                    (objectSet): ObjectSet => ({
                        type: "searchAround",
                        link: linkType.apiName,
                        objectSet,
                    }),
                    true
                );
            },
        },
        `${path}.${fieldName}`
    );

    return [fieldName, field];
}

export const ObjectSetLinkField = {
    create,
};
