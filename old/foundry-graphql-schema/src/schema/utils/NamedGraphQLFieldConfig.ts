import { GraphQLFieldConfig } from "graphql";

// oxlint-disable-next-line typescript/no-explicit-any -- GraphQL registries erase heterogeneous resolver types.
export type NamedGraphQLFieldConfig = [string, GraphQLFieldConfig<any, any>];
