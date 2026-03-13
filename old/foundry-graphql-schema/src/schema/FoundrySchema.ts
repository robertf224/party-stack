import { Result } from "@bobbyfidz/result";
import { GraphQLObjectType } from "graphql";
import { GraphQLSchema } from "graphql";
import { UserQueryFields } from "./admin/UserQueryFields.js";
import { UserType } from "./admin/UserType.js";
import { StringFilterType } from "./filters/StringFilterType.js";
import { ListTypes } from "./ListTypes.js";
import { NodeField } from "./nodes/NodeField.js";
import { NodeInterface } from "./nodes/NodeInterface.js";
import { ActionField } from "./ontology/ActionField.js";
import { ObjectListTypes } from "./ontology/ObjectListTypes.js";
import { ObjectSetFilterType } from "./ontology/ObjectSetFilterType.js";
import { ObjectSetType } from "./ontology/ObjectSetType.js";
import { ObjectType } from "./ontology/ObjectType.js";
import { OntologyQueryFields } from "./ontology/OntologyQueryFields.js";
import { TypeRegistry } from "./utils/TypeRegistry.js";
import type { OntologyFullMetadata } from "@osdk/foundry.ontologies";

function create(ontology: OntologyFullMetadata): GraphQLSchema {
    const typeRegistry = new TypeRegistry();

    const ontologyTypes = Object.values(ontology.objectTypes)
        .flatMap((objectType) => [
            ObjectType.create(typeRegistry, objectType, ontology),
            ObjectSetType.create(typeRegistry, objectType),
            ObjectSetFilterType.create(typeRegistry, objectType),
            ObjectListTypes.createPageType(typeRegistry, objectType.objectType),
            ObjectListTypes.createEdgeType(typeRegistry, objectType.objectType),
            ObjectListTypes.createOrderByType(typeRegistry, objectType.objectType),
            ObjectListTypes.createPropertyNameType(objectType.objectType),
            ObjectListTypes.createFieldOrderingType(typeRegistry, objectType.objectType),
        ])
        .concat([ObjectListTypes.OrderingDirectionType]);

    const adminTypes = [UserType.create(typeRegistry)];

    const filterTypes = [StringFilterType.create()];

    const types = [
        ...ontologyTypes,
        ...adminTypes,
        ListTypes.PageInfoType,
        NodeInterface.create(),
        ...filterTypes,
    ];
    types.forEach(typeRegistry.register);

    return new GraphQLSchema({
        query: new GraphQLObjectType({
            name: "Query",
            fields: typeRegistry.use((getTypeReference) =>
                Object.fromEntries([
                    ...OntologyQueryFields.create(getTypeReference, ontology),
                    ...UserQueryFields.create(getTypeReference),
                    NodeField.create(getTypeReference, [
                        UserType.NODE_ID_HANDLER,
                        ...Object.values(ontology.objectTypes).map((objectType) =>
                            ObjectType.getNodeIdHandler(objectType.objectType)
                        ),
                    ]),
                ])
            ),
        }),
        mutation: new GraphQLObjectType({
            name: "Mutation",
            fields: typeRegistry.use((getTypeReference) =>
                Object.fromEntries([
                    ...Object.values(ontology.actionTypes)
                        .map((actionType) => ActionField.create(getTypeReference, actionType, ontology))
                        // TODO: handle errors.
                        .filter(Result.isOk)
                        .map(Result.unwrap),
                ])
            ),
        }),
        types,
    });
}

export const FoundrySchema = {
    create,
};
