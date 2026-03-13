import { GraphQLBoolean, GraphQLInputType, GraphQLInt, GraphQLScalarType, GraphQLString } from "graphql";
import type { ObjectTypeV2 } from "@osdk/foundry.ontologies";

function getScalarType(objectType: ObjectTypeV2): GraphQLScalarType {
    const primaryKeyProperty = objectType.properties[objectType.primaryKey]!;

    // https://www.palantir.com/docs/foundry/object-link-types/properties-overview#supported-property-types
    switch (primaryKeyProperty.dataType.type) {
        case "boolean":
            return GraphQLBoolean;
        case "byte":
            throw new Error("Byte is not yet supported.");
        case "date":
            throw new Error("Date is not yet supported.");
        case "integer":
            return GraphQLInt;
        case "long":
            throw new Error("Long is not yet supported.");
        case "short":
            throw new Error("Short is not yet supported.");
        case "string":
            return GraphQLString;
        case "timestamp":
            throw new Error("Timestamp is not yet supported.");
        default:
            throw new Error(`Impossible primary key property type ${primaryKeyProperty.dataType.type}.`);
    }
}

function get(objectType: ObjectTypeV2): GraphQLInputType {
    return getScalarType(objectType);
}

export const ObjectArgumentType = {
    get,
};
