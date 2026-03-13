import { GraphQLInputFieldConfig, GraphQLInputObjectType } from "graphql";
import { StringFilter, StringFilterType } from "../filters/StringFilterType.js";
import { GetTypeReference, TypeRegistry } from "../utils/TypeRegistry.js";
import type {
    ObjectTypeFullMetadata,
    ObjectTypeV2,
    PropertyV2,
    SearchJsonQueryV2,
} from "@osdk/foundry.ontologies";

export interface ObjectSetFilter {
    [propertyApiName: string]: StringFilter;
}

function toObjectSetFilter(objectType: ObjectTypeV2, filter: ObjectSetFilter): SearchJsonQueryV2 | undefined {
    const key = Object.keys(filter)[0];
    if (!key) {
        return undefined;
    }
    const property = objectType.properties[key]!;
    switch (property.dataType.type) {
        case "string":
            return StringFilterType.toObjectSetFilter(key, filter[key]!);
        default:
            return undefined;
    }
}

function getFilterType(
    getTypeReference: GetTypeReference,
    property: PropertyV2
): GraphQLInputObjectType | undefined {
    const { dataType } = property;
    switch (dataType.type) {
        case "string":
            return StringFilterType.getReference(getTypeReference);
        default:
            return undefined;
    }
}

function create(typeRegistry: TypeRegistry, objectType: ObjectTypeFullMetadata): GraphQLInputObjectType {
    const typeName = getName(objectType.objectType);
    return new GraphQLInputObjectType({
        name: typeName,
        description: `A filter for a set of ${objectType.objectType.pluralDisplayName}.`,
        // TODO: deprecation.
        isOneOf: true,
        fields: typeRegistry.use((getTypeReference) =>
            Object.fromEntries([
                // TODO: and, or, not
                ...Object.entries(objectType.objectType.properties)
                    .map(([propertyApiName, property]) => {
                        const filterType = getFilterType(getTypeReference, property);
                        return filterType
                            ? ([
                                  propertyApiName,
                                  {
                                      type: filterType,
                                  },
                              ] satisfies [string, GraphQLInputFieldConfig])
                            : undefined;
                    })
                    .filter((propertyFilterField) => propertyFilterField !== undefined),
            ])
        ),
    });
}

function getName(objectType: ObjectTypeV2): string {
    return `${objectType.apiName}SetFilter`;
}

function getReference(getTypeReference: GetTypeReference, objectType: ObjectTypeV2): GraphQLInputObjectType {
    return getTypeReference(getName(objectType)) as GraphQLInputObjectType;
}

export const ObjectSetFilterType = {
    create,
    getReference,
    toObjectSetFilter,
};
