import { NamedGraphQLFieldConfig } from "../utils/NamedGraphQLFieldConfig.js";
import { GetTypeReference } from "../utils/TypeRegistry.js";
import { ObjectQueryField } from "./ObjectQueryField.js";
import { ObjectSearchQueryField } from "./ObjectSearchQueryField.js";
import type { OntologyFullMetadata } from "@osdk/foundry.ontologies";

function create(
    getTypeReference: GetTypeReference,
    ontology: OntologyFullMetadata
): NamedGraphQLFieldConfig[] {
    const objectQueryFields = Object.values(ontology.objectTypes).map(({ objectType }) =>
        ObjectQueryField.create(getTypeReference, objectType)
    );
    const objectSearchQueryFields = Object.values(ontology.objectTypes).map(({ objectType }) =>
        ObjectSearchQueryField.create(getTypeReference, objectType)
    );

    return [...objectQueryFields, ...objectSearchQueryFields];
}

export const OntologyQueryFields = {
    create,
};
