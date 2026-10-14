import { GraphQLList, GraphQLNonNull, GraphQLType } from "graphql";

function required<T extends GraphQLType>(type: T): GraphQLNonNull<T> {
    return new GraphQLNonNull(type);
}

function list<T extends GraphQLType>(type: T): GraphQLList<GraphQLNonNull<T>> {
    return new GraphQLList(required(type));
}

export const Schemas = {
    required,
    list,
};
