import { invariant } from "@bobbyfidz/panic";
import { SchemaIR } from "@party-stack/schema";
import OntologyIRSchema from "./schema.js";
import type { OntologyIR } from "./generated/types.js";

function lift(
    schema: SchemaIR,
    objectTypes: Record<
        string,
        { name?: string; primaryKey: string; displayName: string; pluralDisplayName: string }
    >
): Pick<OntologyIR, "types" | "objectTypes"> {
    return {
        types: schema.types.filter((type) => !(type.name in objectTypes)),
        objectTypes: schema.types
            .filter((type) => type.name in objectTypes)
            .map((type) => {
                invariant(type.type.kind === "struct", "Can only lift struct type into object type.");
                const { name, primaryKey, displayName, pluralDisplayName } = objectTypes[type.name]!;
                return {
                    name: name ?? type.name,
                    displayName: displayName,
                    pluralDisplayName,
                    primaryKey,
                    deprecated: type.deprecated,
                    description: type.description,
                    properties: type.type.value.fields,
                };
            }),
    };
}

export default {
    ...lift(
        { types: OntologyIRSchema.types.filter((type) => type.name !== "OntologyIR") },
        {
            ObjectTypeDef: {
                name: "ObjectType",
                primaryKey: "name",
                displayName: "Object type",
                pluralDisplayName: "Object types",
            },
            LinkTypeDef: {
                name: "LinkType",
                primaryKey: "id",
                displayName: "Link type",
                pluralDisplayName: "Link types",
            },
            NamedTypeDef: {
                name: "ValueType",
                primaryKey: "name",
                displayName: "Value type",
                pluralDisplayName: "Value types",
            },
        }
    ),
    linkTypes: [
        {
            id: "LinkType:source",
            source: { objectType: "LinkType", name: "sourceLinkTypes", displayName: "Source link types" },
            target: {
                objectType: "ObjectType",
                name: "source",
                displayName: "Source",
            },
            foreignKey: "source.objectType",
            cardinality: "many",
        },
        {
            id: "LinkType:target",
            source: { objectType: "LinkType", name: "targetLinkTypes", displayName: "Target link types" },
            target: { objectType: "ObjectType", name: "target", displayName: "Target" },
            foreignKey: "target.objectType",
            cardinality: "many",
        },
    ],
} satisfies OntologyIR;
