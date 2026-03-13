import { GraphQLFieldConfig } from "graphql";

export type NamedGraphQLFieldConfig = [string, GraphQLFieldConfig<any, any>];
