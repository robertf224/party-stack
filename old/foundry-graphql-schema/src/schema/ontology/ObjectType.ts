import { Result } from "@bobbyfidz/result";
import { LoadedRecordStep, nodeIdFromNode, NodeIdHandler, objectFieldSpec } from "grafast";
import { GraphQLID, GraphQLObjectType } from "graphql";
import { NodeHandlers } from "../nodes/NodeHandlers.js";
import { NodeInterface } from "../nodes/NodeInterface.js";
import { Schemas } from "../utils/Schemas.js";
import { TypedOntologyObject } from "../utils/TypedOntologyObject.js";
import { GetTypeReference, TypeRegistry } from "../utils/TypeRegistry.js";
import { getObjectLoader } from "./getObjectLoader.js";
import { ObjectLinkField } from "./ObjectLinkField.js";
import { LoadedObjectStep } from "./ObjectListStep.js";
import { ObjectPropertyField } from "./ObjectPropertyField.js";
import { ObjectUserLinkField } from "./ObjectUserLinkField.js";
import type {
    ObjectTypeApiName,
    ObjectTypeFullMetadata,
    ObjectTypeV2,
    OntologyFullMetadata,
} from "@osdk/foundry.ontologies";

const nodeIdHandlerCache = new WeakMap<ObjectTypeV2, NodeIdHandler>();
function getNodeIdHandler(objectType: ObjectTypeV2): NodeIdHandler {
    let handler = nodeIdHandlerCache.get(objectType);
    if (handler) {
        return handler;
    }
    handler = NodeHandlers.createBasicHandler(
        objectType.apiName,
        objectType.primaryKey,
        getObjectLoader(objectType)
    );
    nodeIdHandlerCache.set(objectType, handler);
    return handler;
}

function create(
    typeRegistry: TypeRegistry,
    objectType: ObjectTypeFullMetadata,
    ontology: OntologyFullMetadata
): GraphQLObjectType {
    const typeName = getName(objectType.objectType);
    return new GraphQLObjectType({
        name: typeName,
        description: objectType.objectType.description,
        fields: typeRegistry.use((getTypeReference) => {
            const idField = objectFieldSpec<LoadedRecordStep<TypedOntologyObject> | LoadedObjectStep>(
                {
                    type: Schemas.required(GraphQLID),
                    plan: ($object) => {
                        return nodeIdFromNode(getNodeIdHandler(objectType.objectType), $object);
                    },
                },
                `${typeName}.${NodeInterface.FIELD_NAME}`
            );
            const propertyFields = Object.entries(objectType.objectType.properties)
                .map((property) => ObjectPropertyField.create(typeName, property))
                // TODO: handle errors
                .filter(Result.isOk)
                .map(Result.unwrap);
            const linkFields = objectType.linkTypes.map((linkType) =>
                ObjectLinkField.create(typeName, getTypeReference, linkType, objectType.objectType, ontology)
            );
            const userLinkFields = Object.entries(objectType.objectType.properties)
                .filter(
                    ([, property]) =>
                        property.valueFormatting?.type === "knownType" &&
                        property.valueFormatting.knownType === "USER_OR_GROUP_ID"
                )
                .map((property) => ObjectUserLinkField.create(typeName, getTypeReference, property));
            return Object.fromEntries([
                [NodeInterface.FIELD_NAME, idField],
                ...propertyFields,
                ...linkFields,
                ...userLinkFields,
            ]);
        }),
        interfaces: typeRegistry.use((getTypeReference) => [NodeInterface.getReference(getTypeReference)]),
    });
}

function getName(objectType: ObjectTypeV2): string {
    return objectType.apiName;
}

function getReference(getTypeReference: GetTypeReference, objectType: ObjectTypeV2): GraphQLObjectType {
    return getTypeReference(getName(objectType)) as GraphQLObjectType;
}

function getReferenceByName(
    getTypeReference: GetTypeReference,
    apiName: ObjectTypeApiName
): GraphQLObjectType {
    return getTypeReference(apiName) as GraphQLObjectType;
}

export const ObjectType = {
    create,
    getReference,
    getReferenceByName,
    getNodeIdHandler,
};
