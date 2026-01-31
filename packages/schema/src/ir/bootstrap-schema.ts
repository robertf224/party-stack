/**
 * The IR format described in the IR format itself.
 *
 * This enables bootstrapping: we can use our own codegen to generate
 * Zod schemas and builders for the IR types.
 */
import type { SchemaIR, TypeDef, UnionTypeDef } from "./ir.js";

// Helper to create type defs more concisely
const string = (): TypeDef => ({ kind: "string", value: {} });

const ref = (name: string): TypeDef => ({ kind: "ref", value: { name } });

const list = (elementType: TypeDef): TypeDef => ({ kind: "list", value: { elementType } });

const struct = (
    fields: Array<{
        name: string;
        displayName: string;
        type: TypeDef;
        description?: string;
    }>
): TypeDef => ({ kind: "struct", value: { fields } });

const union = (variants: Array<{ name: string; type: TypeDef }>): TypeDef => ({
    kind: "union",
    value: { variants },
});

const optional = (type: TypeDef): TypeDef => ({ kind: "optional", value: { type } });

export default {
    types: [
        // String enum constraint
        {
            name: "StringEnumConstraint",
            description: "Constrains a string to a set of allowed values.",
            type: struct([
                {
                    name: "options",
                    displayName: "Options",
                    type: list(
                        struct([
                            { name: "value", displayName: "Value", type: string() },
                            { name: "label", displayName: "Label", type: optional(string()) },
                        ])
                    ),
                },
            ]),
        },

        // String constraint (currently only enum)
        {
            name: "StringConstraint",
            description: "A constraint that can be applied to a string type.",
            type: union([{ name: "enum", type: ref("StringEnumConstraint") }]),
        },

        // Primitive type defs
        {
            name: "StringTypeDef",
            description: "A string type with optional constraints.",
            type: struct([
                {
                    name: "constraint",
                    displayName: "Constraint",
                    type: optional(ref("StringConstraint")),
                },
            ]),
        },
        {
            name: "BooleanTypeDef",
            description: "A boolean type.",
            type: struct([]),
        },
        {
            name: "IntegerTypeDef",
            description: "A 32-bit integer type.",
            type: struct([]),
        },
        {
            name: "FloatTypeDef",
            description: "A 32-bit floating point type.",
            type: struct([]),
        },
        {
            name: "DoubleTypeDef",
            description: "A 64-bit floating point type.",
            type: struct([]),
        },
        {
            name: "DateTypeDef",
            description: "A date type (no time component).",
            type: struct([]),
        },
        {
            name: "TimestampTypeDef",
            description: "A timestamp type (instant in time).",
            type: struct([]),
        },
        {
            name: "GeopointTypeDef",
            description: "A geographic point (lat/lon).",
            type: struct([]),
        },

        // Collection type defs
        {
            name: "ListTypeDef",
            description: "A list/array type.",
            type: struct([
                {
                    name: "elementType",
                    displayName: "Element Type",
                    type: ref("TypeDef"),
                    description: "The type of elements in the list.",
                },
            ]),
        },
        {
            name: "MapTypeDef",
            description: "A map/record type.",
            type: struct([
                {
                    name: "keyType",
                    displayName: "Key Type",
                    type: ref("TypeDef"),
                    description: "The type of keys (must be string).",
                },
                {
                    name: "valueType",
                    displayName: "Value Type",
                    type: ref("TypeDef"),
                    description: "The type of values.",
                },
            ]),
        },

        // Struct-related definitions
        {
            name: "FieldDef",
            description: "Definition of a field in a struct.",
            type: struct([
                {
                    name: "id",
                    displayName: "ID",
                    type: optional(string()),
                    description: "Optional unique identifier.",
                },
                {
                    name: "name",
                    displayName: "API Name",
                    type: string(),
                    description: "The field name in code.",
                },
                {
                    name: "displayName",
                    displayName: "Display Name",
                    type: string(),
                    description: "Human-readable name.",
                },
                {
                    name: "type",
                    displayName: "Type",
                    type: ref("TypeDef"),
                    description: "The field's type.",
                },
                {
                    name: "description",
                    displayName: "Description",
                    type: optional(string()),
                    description: "Optional description.",
                },
            ]),
        },
        {
            name: "StructTypeDef",
            description: "A struct type with named fields.",
            type: struct([
                {
                    name: "fields",
                    displayName: "Fields",
                    type: list(ref("FieldDef")),
                },
            ]),
        },

        // Union-related definitions
        {
            name: "VariantDef",
            description: "Definition of a variant in a discriminated union.",
            type: struct([
                {
                    name: "name",
                    displayName: "API Name",
                    type: string(),
                    description: "The variant's discriminator value.",
                },
                {
                    name: "type",
                    displayName: "Type",
                    type: ref("TypeDef"),
                    description: "The variant's payload type.",
                },
            ]),
        },
        {
            name: "UnionTypeDef",
            description: "A discriminated union type.",
            type: struct([
                {
                    name: "variants",
                    displayName: "Variants",
                    type: list(ref("VariantDef")),
                },
            ]),
        },

        // Optional wrapper
        {
            name: "OptionalTypeDef",
            description: "Wraps a type to make it optional.",
            type: struct([
                {
                    name: "type",
                    displayName: "Type",
                    type: ref("TypeDef"),
                    description: "The wrapped type.",
                },
            ]),
        },

        // Result type
        {
            name: "ResultTypeDef",
            description: "A result type (ok or error).",
            type: struct([
                {
                    name: "okType",
                    displayName: "Ok Type",
                    type: ref("TypeDef"),
                    description: "The type of the success value.",
                },
                {
                    name: "errType",
                    displayName: "Error Type",
                    type: ref("TypeDef"),
                    description: "The type of the error value.",
                },
            ]),
        },

        // Type reference
        {
            name: "TypeRef",
            description: "A reference to a named type.",
            type: struct([
                {
                    name: "name",
                    displayName: "API Name",
                    type: string(),
                    description: "The name of the referenced type.",
                },
            ]),
        },

        // The main TypeDef union
        {
            name: "TypeDef",
            description:
                "A type definition. Can be a primitive, collection, struct, union, optional, result, or reference.",
            type: union([
                // Primitives
                { name: "string", type: ref("StringTypeDef") },
                { name: "boolean", type: ref("BooleanTypeDef") },
                { name: "integer", type: ref("IntegerTypeDef") },
                { name: "float", type: ref("FloatTypeDef") },
                { name: "double", type: ref("DoubleTypeDef") },
                { name: "date", type: ref("DateTypeDef") },
                { name: "timestamp", type: ref("TimestampTypeDef") },
                { name: "geopoint", type: ref("GeopointTypeDef") },
                // Collections
                { name: "list", type: ref("ListTypeDef") },
                { name: "map", type: ref("MapTypeDef") },
                // Complex types
                { name: "struct", type: ref("StructTypeDef") },
                { name: "union", type: ref("UnionTypeDef") },
                { name: "optional", type: ref("OptionalTypeDef") },
                { name: "result", type: ref("ResultTypeDef") },
                { name: "ref", type: ref("TypeRef") },
            ] satisfies UnionTypeDef["variants"]),
        },

        // Named type definition (top-level type with name)
        {
            name: "NamedTypeDef",
            description: "A named type definition that can be referenced by other types.",
            type: struct([
                {
                    name: "name",
                    displayName: "API Name",
                    type: string(),
                    description: "The type's name for use in code.",
                },
                {
                    name: "description",
                    displayName: "Description",
                    type: optional(string()),
                    description: "Optional documentation for the type.",
                },
                {
                    name: "type",
                    displayName: "Type",
                    type: ref("TypeDef"),
                    description: "The type definition.",
                },
            ]),
        },

        // The root schema type
        {
            name: "SchemaIR",
            description: "The root schema containing all type definitions.",
            type: struct([
                {
                    name: "types",
                    displayName: "Types",
                    type: list(ref("NamedTypeDef")),
                    description: "All named types in the schema.",
                },
            ]),
        },
    ],
} satisfies SchemaIR;
