/**
 * The Ontology Ontology: an OntologyIR instance that describes the ontology
 * system itself. This is the "information_schema" layer -- it enables ontology
 * metadata to be stored and queried in the same data layer as user data.
 *
 * Object types:  ObjectType, ValueType, LinkType
 * Links:         LinkType -> ObjectType for source and target
 */

import { o } from "./generated/builders.js";
import type { OntologyIR } from "./generated/types.js";

/** Inline property shape used on ObjectType and ValueType. */
const propertyDef = o.struct({
    fields: [
        {
            name: "apiName",
            displayName: "API Name",
            type: o.string({}),
            description: "The property's programmatic name.",
        },
        {
            name: "displayName",
            displayName: "Display Name",
            type: o.string({}),
            description: "Human-readable name.",
        },
        {
            name: "type",
            displayName: "Type",
            type: o.string({}),
            description: "Serialised TypeDef (the property's type definition).",
        },
        {
            name: "description",
            displayName: "Description",
            type: o.optional({ type: o.string({}) }),
            description: "Optional description.",
        },
    ],
});

export const ontologyOntology = {
    valueTypes: [],

    objectTypes: [
        {
            apiName: "ObjectType",
            displayName: "Object Type",
            description: "An object type in the ontology.",
            primaryKey: "apiName",
            properties: [
                {
                    apiName: "apiName",
                    displayName: "API Name",
                    type: o.string({}),
                    description: "The object type's programmatic name.",
                },
                {
                    apiName: "displayName",
                    displayName: "Display Name",
                    type: o.string({}),
                    description: "Human-readable name.",
                },
                {
                    apiName: "primaryKey",
                    displayName: "Primary Key",
                    type: o.string({}),
                    description: "The apiName of the property that serves as primary key.",
                },
                {
                    apiName: "properties",
                    displayName: "Properties",
                    type: o.list({ elementType: propertyDef }),
                    description: "The object type's properties.",
                },
                {
                    apiName: "description",
                    displayName: "Description",
                    type: o.optional({ type: o.string({}) }),
                    description: "Optional description.",
                },
            ],
        },
        {
            apiName: "ValueType",
            displayName: "Value Type",
            description: "A named, reusable value type shared across object types.",
            primaryKey: "apiName",
            properties: [
                {
                    apiName: "apiName",
                    displayName: "API Name",
                    type: o.string({}),
                    description: "The value type's programmatic name.",
                },
                {
                    apiName: "displayName",
                    displayName: "Display Name",
                    type: o.string({}),
                    description: "Human-readable name.",
                },
                {
                    apiName: "type",
                    displayName: "Type",
                    type: o.string({}),
                    description: "Serialised TypeDef (the value type's definition).",
                },
                {
                    apiName: "description",
                    displayName: "Description",
                    type: o.optional({ type: o.string({}) }),
                    description: "Optional description.",
                },
            ],
        },
        {
            apiName: "LinkType",
            displayName: "Link Type",
            description: "A relationship between two object types.",
            primaryKey: "apiName",
            properties: [
                {
                    apiName: "apiName",
                    displayName: "API Name",
                    type: o.string({}),
                    description: "The link type's programmatic name (from source's perspective).",
                },
                {
                    apiName: "displayName",
                    displayName: "Display Name",
                    type: o.string({}),
                    description: "Human-readable name.",
                },
                {
                    apiName: "sourceObjectType",
                    displayName: "Source Object Type",
                    type: o.string({}),
                    description: "The apiName of the source object type.",
                },
                {
                    apiName: "targetObjectType",
                    displayName: "Target Object Type",
                    type: o.string({}),
                    description: "The apiName of the target object type.",
                },
                {
                    apiName: "cardinality",
                    displayName: "Cardinality",
                    type: o.string({
                        constraint: o.StringConstraint.enum({
                            options: [
                                { value: "one", label: "One" },
                                { value: "many", label: "Many" },
                            ],
                        }),
                    }),
                    description: "The cardinality from the source's perspective.",
                },
                {
                    apiName: "description",
                    displayName: "Description",
                    type: o.optional({ type: o.string({}) }),
                    description: "Optional description.",
                },
            ],
        },
    ],

    linkTypes: [
        {
            apiName: "linkTypeSource",
            displayName: "Source Object Type",
            description: "The source object type of a link.",
            sourceObjectType: "LinkType",
            targetObjectType: "ObjectType",
            cardinality: "one" as const,
        },
        {
            apiName: "linkTypeTarget",
            displayName: "Target Object Type",
            description: "The target object type of a link.",
            sourceObjectType: "LinkType",
            targetObjectType: "ObjectType",
            cardinality: "one" as const,
        },
    ],
} satisfies OntologyIR;
