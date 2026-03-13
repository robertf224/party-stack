import { GraphQLBoolean, GraphQLFieldConfig, GraphQLObjectType, GraphQLString } from "graphql";
import { Schemas } from "./utils/Schemas.js";
import { GetTypeReference, TypeRegistry } from "./utils/TypeRegistry.js";

export interface PageInfo {
    hasNextPage: boolean;
    endCursor?: string;
}

const PageInfoType = new GraphQLObjectType({
    name: "PageInfo",
    description: "Information about pagination for a page of records.",
    fields: {
        hasNextPage: {
            description: "Whether there are additional records after this page.",
            type: Schemas.required(GraphQLBoolean),
        },
        endCursor: {
            description: "A cursor that can be used to continue forward pagination.",
            type: GraphQLString,
        },
    },
});

function createPageType(
    typeRegistry: TypeRegistry,
    typeName: string,
    pluralDisplayName: string
): GraphQLObjectType {
    return new GraphQLObjectType({
        name: getPageTypeName(typeName),
        description: `A page of ${pluralDisplayName}.`,
        fields: typeRegistry.use<GraphQLFieldConfig<any, any, any>>((getTypeReference) => ({
            edges: {
                description: `A list of ${pluralDisplayName}.`,
                type: Schemas.list(getTypeReference(getEdgeTypeName(typeName)) as GraphQLObjectType),
            },
            pageInfo: {
                description: "Information about pagination for this page.",
                type: PageInfoType,
            },
        })),
    });
}

function getPageTypeName(typeName: string): string {
    return `${typeName}Page`;
}

function getPageTypeReference(getTypeReference: GetTypeReference, typeName: string): GraphQLObjectType {
    return getTypeReference(getPageTypeName(typeName)) as GraphQLObjectType;
}

function createEdgeType(
    typeRegistry: TypeRegistry,
    typeName: string,
    displayName: string,
    nodeTypeName: string,
    nodeDisplayName: string
): GraphQLObjectType {
    return new GraphQLObjectType({
        name: getEdgeTypeName(typeName),
        description: `A ${displayName} edge.`,
        fields: typeRegistry.use((getTypeReference) => ({
            node: {
                description: `The ${nodeDisplayName} at the end of the edge.`,
                type: Schemas.required(getTypeReference(nodeTypeName) as GraphQLObjectType),
            },
        })),
    });
}

function getEdgeTypeName(typeName: string): string {
    return `${typeName}Edge`;
}

export const ListTypes = {
    createPageType,
    getPageTypeReference,
    createEdgeType,
    PageInfoType,
};
