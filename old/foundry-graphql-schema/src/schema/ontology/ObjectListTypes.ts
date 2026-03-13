import { ObjectTypeV2 } from "@osdk/foundry.ontologies";
import { GraphQLObjectType, GraphQLEnumType, GraphQLEnumValueConfig, GraphQLInputObjectType } from "graphql";
import { ListTypes } from "../ListTypes.js";
import { Schemas } from "../utils/Schemas.js";
import { GetTypeReference, TypeRegistry } from "../utils/TypeRegistry.js";

function createPageType(typeRegistry: TypeRegistry, objectType: ObjectTypeV2): GraphQLObjectType {
    return ListTypes.createPageType(typeRegistry, objectType.apiName, objectType.pluralDisplayName);
}

function createEdgeType(typeRegistry: TypeRegistry, objectType: ObjectTypeV2): GraphQLObjectType {
    return ListTypes.createEdgeType(
        typeRegistry,
        objectType.apiName,
        objectType.displayName,
        objectType.apiName,
        objectType.displayName
    );
}

function getPageTypeReference(
    getTypeReference: GetTypeReference,
    objectType: ObjectTypeV2
): GraphQLObjectType {
    return ListTypes.getPageTypeReference(getTypeReference, objectType.apiName);
}

const OrderingDirectionType = new GraphQLEnumType({
    name: "OrderingDirection",
    values: {
        asc: {
            value: "asc",
            description: "Ascending order",
        },
        desc: {
            value: "desc",
            description: "Descending order",
        },
    },
});

function createPropertyNameType(objectType: ObjectTypeV2): GraphQLEnumType {
    return new GraphQLEnumType({
        name: `${objectType.apiName}PropertyName`,
        values: Object.fromEntries(
            Object.entries(objectType.properties).map(([propertyApiName, property]) => [
                propertyApiName,
                {
                    value: propertyApiName,
                    description: property.description,
                } satisfies GraphQLEnumValueConfig,
            ])
        ),
    });
}

function getPropertyNameTypeReference(
    getTypeReference: GetTypeReference,
    objectType: ObjectTypeV2
): GraphQLEnumType {
    return getTypeReference(`${objectType.apiName}PropertyName`) as GraphQLEnumType;
}

function createFieldOrderingType(
    typeRegistry: TypeRegistry,
    objectType: ObjectTypeV2
): GraphQLInputObjectType {
    return new GraphQLInputObjectType({
        name: `${objectType.apiName}FieldOrdering`,
        fields: typeRegistry.use((getTypeReference) => ({
            direction: { type: OrderingDirectionType },
            field: { type: getPropertyNameTypeReference(getTypeReference, objectType) },
        })),
    });
}

function getFieldOrderingTypeReference(
    getTypeReference: GetTypeReference,
    objectType: ObjectTypeV2
): GraphQLInputObjectType {
    return getTypeReference(`${objectType.apiName}FieldOrdering`) as GraphQLInputObjectType;
}

function createOrderByType(typeRegistry: TypeRegistry, objectType: ObjectTypeV2): GraphQLInputObjectType {
    return new GraphQLInputObjectType({
        name: `${objectType.apiName}OrderBy`,
        isOneOf: true,
        fields: typeRegistry.use((getTypeReference) => ({
            fields: {
                type: Schemas.list(getFieldOrderingTypeReference(getTypeReference, objectType)),
            },
        })),
    });
}

function getOrderByTypeReference(
    getTypeReference: GetTypeReference,
    objectType: ObjectTypeV2
): GraphQLInputObjectType {
    return getTypeReference(`${objectType.apiName}OrderBy`) as GraphQLInputObjectType;
}

export const ObjectListTypes = {
    createPageType,
    getPageTypeReference,
    createEdgeType,
    OrderingDirectionType,
    createPropertyNameType,
    createFieldOrderingType,
    createOrderByType,
    getOrderByTypeReference,
};
