import type {
    MetaObjectProperty,
    MetaObjectType,
} from "@party-stack/ontology";
import { convertFoundryObjectPropertyType } from "./convertMetaTypeDef.js";
import type {
    ObjectTypeFullMetadata,
    PropertyV2,
} from "@osdk/foundry.ontologies";

export function convertFoundryMetaObjectType(
    metadata: ObjectTypeFullMetadata
): MetaObjectType {
    const objectType = metadata.objectType;
    return {
        id: objectType.rid,
        name: objectType.apiName,
        displayName: objectType.displayName,
        pluralDisplayName: objectType.pluralDisplayName,
        primaryKey: objectType.primaryKey,
        title: objectType.titleProperty,
        description: objectType.description,
        properties: Object.entries(objectType.properties).map(([name, property]) =>
            convertFoundryObjectProperty(
                name,
                property,
                name === objectType.primaryKey
            )
        ),
    };
}

function convertFoundryObjectProperty(
    name: string,
    property: PropertyV2,
    required: boolean
): MetaObjectProperty {
    const type = property.valueTypeApiName
        ? { kind: "ref" as const, value: { name: property.valueTypeApiName } }
        : convertFoundryObjectPropertyType(property.dataType);
    return {
        id: property.rid,
        name,
        displayName: property.displayName ?? name,
        description: property.description,
        deprecated:
            property.status?.type === "deprecated"
                ? {
                      message: property.status.message,
                  }
                : undefined,
        type: required
            ? type
            : {
                  kind: "optional",
                  value: { type },
              },
    };
}
