import { s, SchemaIRSchema } from "@party-stack/schema";
import type { SchemaIR } from "@party-stack/schema";

export default {
    types: [
        ...SchemaIRSchema.types.filter((type) => type.name !== "SchemaIR"),
        {
            name: "PropertyDef",
            description: "A property on an Object type.",
            type: s.struct({
                fields: [
                    {
                        name: "name",
                        displayName: "Name",
                        type: s.string({}),
                        description: "The property's name.",
                    },
                    {
                        name: "displayName",
                        displayName: "Display name",
                        type: s.string({}),
                        description: "Human-readable name.",
                    },
                    {
                        name: "type",
                        displayName: "Type",
                        type: s.ref({ name: "TypeDef" }),
                        description: "The property's type.",
                    },
                    {
                        name: "description",
                        displayName: "Description",
                        type: s.optional({ type: s.string({}) }),
                        description: "Optional description.",
                    },
                    {
                        name: "deprecated",
                        displayName: "Deprecated?",
                        type: s.optional({ type: s.ref({ name: "Deprecation" }) }),
                    },
                ],
            }),
        },
        {
            name: "ObjectTypeDef",
            description: "An object type in the ontology.",
            type: s.struct({
                fields: [
                    {
                        name: "name",
                        displayName: "Name",
                        type: s.string({}),
                        description: "The object type's programmatic name.",
                    },
                    {
                        name: "displayName",
                        displayName: "Display name",
                        type: s.string({}),
                        description: "Human-readable name.",
                    },
                    {
                        name: "pluralDisplayName",
                        displayName: "Plural display name",
                        type: s.string({}),
                    },
                    {
                        name: "primaryKey",
                        displayName: "Primary key",
                        type: s.string({}),
                        description: "The name of the property that serves as primary key.",
                    },
                    {
                        name: "properties",
                        displayName: "Properties",
                        type: s.list({ elementType: s.ref({ name: "PropertyDef" }) }),
                        description: "The object type's properties.",
                    },
                    {
                        name: "description",
                        displayName: "Description",
                        type: s.optional({ type: s.string({}) }),
                        description: "Optional description.",
                    },
                    {
                        name: "deprecated",
                        displayName: "Deprecated?",
                        type: s.optional({ type: s.ref({ name: "Deprecation" }) }),
                    },
                ],
            }),
        },
        {
            name: "LinkTypeSideDef",
            type: s.struct({
                fields: [
                    {
                        name: "objectType",
                        displayName: "Object type",
                        type: s.string({}),
                    },
                    {
                        name: "name",
                        displayName: "Name",
                        type: s.string({}),
                    },
                    {
                        name: "displayName",
                        displayName: "Display name",
                        type: s.string({}),
                    },
                ],
            }),
        },
        {
            name: "LinkCardinality",
            description: "The cardinality of a link from the source's perspective.",
            type: s.string({
                constraint: s.StringConstraint.enum({
                    options: [
                        { value: "one", label: "One" },
                        { value: "many", label: "Many" },
                    ],
                }),
            }),
        },
        {
            name: "LinkTypeDef",
            description: "A relationship between two object types.",
            type: s.struct({
                fields: [
                    {
                        name: "id",
                        displayName: "ID",
                        type: s.string({}),
                    },
                    {
                        name: "source",
                        displayName: "Source",
                        type: s.ref({ name: "LinkTypeSideDef" }),
                    },
                    {
                        name: "target",
                        displayName: "Target",
                        type: s.ref({ name: "LinkTypeSideDef" }),
                    },
                    {
                        name: "foreignKey",
                        displayName: "Foreign key",
                        type: s.string({}),
                        description: "The foreign key on the source.",
                    },
                    {
                        name: "cardinality",
                        displayName: "Cardinality",
                        type: s.string({
                            constraint: s.StringConstraint.enum({
                                options: [
                                    { value: "one", label: "One" },
                                    { value: "many", label: "Many" },
                                ],
                            }),
                        }),
                        description: "How many sources are linked to the target.",
                    },
                ],
            }),
        },
        {
            name: "OntologyIR",
            description: "The root ontology definition containing all type definitions.",
            type: s.struct({
                fields: [
                    {
                        name: "types",
                        displayName: "Named types",
                        type: s.list({ elementType: s.ref({ name: "NamedTypeDef" }) }),
                        description: "Named, reusable value types.",
                    },
                    {
                        name: "objectTypes",
                        displayName: "Object types",
                        type: s.list({ elementType: s.ref({ name: "ObjectTypeDef" }) }),
                        description: "Object type definitions.",
                    },
                    {
                        name: "linkTypes",
                        displayName: "Link types",
                        type: s.list({ elementType: s.ref({ name: "LinkTypeDef" }) }),
                        description: "Relationship definitions between object types.",
                    },
                ],
            }),
        },
    ],
} satisfies SchemaIR;
