import type { MetaObjectType, PropertyDef } from "@party-stack/ontology";
import { convertFoundryObjectPropertyType } from "./convertMetaTypeDef.js";
import type { ObjectTypeFullMetadata, PropertyV2 } from "@osdk/foundry.ontologies";

export function convertFoundryMetaObjectType(objectType: ObjectTypeFullMetadata): MetaObjectType {
    return {
        name: objectType.objectType.apiName,
        displayName: objectType.objectType.displayName,
        pluralDisplayName: objectType.objectType.pluralDisplayName,
        primaryKey: objectType.objectType.primaryKey,
        description: objectType.objectType.description,
        properties: Object.entries(objectType.objectType.properties).map(([name, property]) =>
            convertFoundryObjectProperty(name, property)
        ),
    };
}

function convertFoundryObjectProperty(name: string, property: PropertyV2): PropertyDef {
    return {
        name,
        displayName: property.displayName ?? name,
        description: property.description,
        type: property.valueTypeApiName
            ? { kind: "ref", value: { name: property.valueTypeApiName } }
            : convertFoundryObjectPropertyType(property.dataType),
    };
}
