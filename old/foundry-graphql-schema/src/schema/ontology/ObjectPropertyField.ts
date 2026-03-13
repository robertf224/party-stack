import { unreachable } from "@bobbyfidz/panic";
import { Result } from "@bobbyfidz/result";
import { LoadedRecordStep, objectFieldSpec } from "grafast";
import { GraphQLBoolean, GraphQLFloat, GraphQLInt, GraphQLOutputType, GraphQLString } from "graphql";
import { NamedGraphQLFieldConfig } from "../utils/NamedGraphQLFieldConfig.js";
import { Schemas } from "../utils/Schemas.js";
import { TypedOntologyObject } from "../utils/TypedOntologyObject.js";
import { LoadedObjectStep } from "./ObjectListStep.js";
import type {
    ObjectPropertyType,
    PropertyApiName,
    PropertyTypeStatus,
    PropertyV2,
} from "@osdk/foundry.ontologies";

function getFieldType(type: ObjectPropertyType): Result<GraphQLOutputType> {
    // TODO: wrap w/ required when property is required
    // TODO: consider data constraints + value types
    switch (type.type) {
        case "array":
            return Result.map(getFieldType(type.subType), Schemas.list);
        case "attachment":
            return Result.err(new Error("Attachment type not supported."));
        case "boolean":
            return Result.ok(GraphQLBoolean);
        case "byte":
            return Result.err(new Error("Byte type not supported."));
        case "cipherText":
            return Result.err(new Error("CipherText type not supported."));
        case "date":
            return Result.err(new Error("Date type not supported."));
        case "decimal":
            return Result.err(new Error("Decimal type not supported."));
        case "double":
            return Result.ok(GraphQLFloat);
        case "float":
            return Result.ok(GraphQLFloat);
        case "geopoint":
            return Result.err(new Error("Geopoint type not supported."));
        case "geoshape":
            return Result.err(new Error("Geoshape type not supported."));
        case "geotimeSeriesReference":
            return Result.err(new Error("GeotimeSeriesReference type not supported."));
        case "integer":
            return Result.ok(GraphQLInt);
        case "long":
            return Result.err(new Error("Long type not supported."));
        case "marking":
            return Result.err(new Error("Marking type not supported."));
        case "mediaReference":
            return Result.err(new Error("MediaReference type not supported."));
        case "short":
            return Result.err(new Error("Short type not supported."));
        case "string":
            return Result.ok(GraphQLString);
        case "struct":
            return Result.err(new Error("Struct type not supported."));
        case "timeseries":
            return Result.err(new Error("Timeseries type not supported."));
        case "timestamp":
            return Result.err(new Error("Timestamp type not supported."));
        case "vector":
            return Result.err(new Error("Vector type not supported."));
        default:
            unreachable(type);
    }
}

function getDeprecationReason(status: PropertyTypeStatus | undefined): string | undefined {
    if (status?.type === "deprecated") {
        const messages = [status.deadline];
        if (status.replacedBy) {
            messages.push(`use ${status.replacedBy} instead`);
        }
        messages.push(status.message);
        return messages.join(" - ");
    }
}

function create(
    path: string,
    [propertyApiName, property]: [PropertyApiName, PropertyV2]
): Result<NamedGraphQLFieldConfig> {
    return Result.map(getFieldType(property.dataType), (type) => {
        const field = objectFieldSpec<LoadedRecordStep<TypedOntologyObject> | LoadedObjectStep>(
            {
                description: property.description,
                deprecationReason: getDeprecationReason(property.status),
                type,
                plan: ($object) => {
                    return $object.get(propertyApiName);
                },
            },
            `${path}.${propertyApiName}`
        );
        return [propertyApiName, field];
    });
}

export const ObjectPropertyField = {
    create,
};
