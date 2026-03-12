import { s } from "./generated/builders.js";
import type { SchemaIR } from "./generated/types.js";

export default {
    types: [
        {
            name: "Deprecation",
            type: s.struct({
                fields: [
                    {
                        name: "message",
                        displayName: "Message",
                        type: s.string({}),
                    },
                ],
            }),
        },
        {
            name: "StringEnumConstraint",
            description: "Constrains a string to a set of allowed values.",
            type: s.struct({
                fields: [
                    {
                        name: "options",
                        displayName: "Options",
                        type: s.list({
                            elementType: s.struct({
                                fields: [
                                    { name: "value", displayName: "Value", type: s.string({}) },
                                    {
                                        name: "label",
                                        displayName: "Label",
                                        type: s.optional({ type: s.string({}) }),
                                    },
                                ],
                            }),
                        }),
                    },
                ],
            }),
        },
        {
            name: "StringRegexConstraint",
            description: "Constrains a string to a regex.",
            type: s.struct({
                fields: [
                    {
                        name: "regex",
                        displayName: "Regex",
                        type: s.string({}),
                    },
                ],
            }),
        },
        {
            name: "StringConstraint",
            description: "A constraint that can be applied to a string type.",
            type: s.union({
                variants: [
                    { name: "enum", type: s.ref({ name: "StringEnumConstraint" }) },
                    { name: "regex", type: s.ref({ name: "StringRegexConstraint" }) },
                ],
            }),
        },
        {
            name: "StringTypeDef",
            description: "A string type with optional constraints.",
            type: s.struct({
                fields: [
                    {
                        name: "constraint",
                        displayName: "Constraint",
                        type: s.optional({ type: s.ref({ name: "StringConstraint" }) }),
                    },
                ],
            }),
        },
        {
            name: "BooleanTypeDef",
            description: "A boolean type.",
            type: s.struct({ fields: [] }),
        },
        {
            name: "IntegerTypeDef",
            description: "A 32-bit integer type.",
            type: s.struct({ fields: [] }),
        },
        {
            name: "FloatTypeDef",
            description: "A 32-bit floating point type.",
            type: s.struct({ fields: [] }),
        },
        {
            name: "DoubleTypeDef",
            description: "A 64-bit floating point type.",
            type: s.struct({ fields: [] }),
        },
        {
            name: "DateTypeDef",
            description: "A date type (no time component).",
            type: s.struct({ fields: [] }),
        },
        {
            name: "TimestampTypeDef",
            description: "A timestamp type (instant in time).",
            type: s.struct({ fields: [] }),
        },
        {
            name: "GeopointTypeDef",
            description: "A geographic point (lat/lon).",
            type: s.struct({ fields: [] }),
        },
        {
            name: "AttachmentTypeDef",
            description: "A file handle.",
            type: s.struct({ fields: [] }),
        },
        {
            name: "ListTypeDef",
            description: "A list/array type.",
            type: s.struct({
                fields: [
                    {
                        name: "elementType",
                        displayName: "Element Type",
                        type: s.ref({ name: "TypeDef" }),
                        description: "The type of elements in the list.",
                    },
                ],
            }),
        },
        {
            name: "MapTypeDef",
            description: "A map/record type.",
            type: s.struct({
                fields: [
                    {
                        name: "keyType",
                        displayName: "Key Type",
                        type: s.ref({ name: "TypeDef" }),
                        description: "The type of keys (must be string right now).",
                    },
                    {
                        name: "valueType",
                        displayName: "Value Type",
                        type: s.ref({ name: "TypeDef" }),
                        description: "The type of values.",
                    },
                ],
            }),
        },
        {
            name: "FieldDef",
            description: "Definition of a field in a struct.",
            type: s.struct({
                fields: [
                    {
                        name: "name",
                        displayName: "Name",
                        type: s.string({}),
                        description: "The field name in code.",
                    },
                    {
                        name: "displayName",
                        displayName: "Display Name",
                        type: s.string({}),
                        description: "Human-readable name.",
                    },
                    {
                        name: "type",
                        displayName: "Type",
                        type: s.ref({ name: "TypeDef" }),
                        description: "The field's type.",
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
            name: "StructTypeDef",
            description: "A struct type with named fields.",
            type: s.struct({
                fields: [
                    {
                        name: "fields",
                        displayName: "Fields",
                        type: s.list({ elementType: s.ref({ name: "FieldDef" }) }),
                    },
                ],
            }),
        },
        {
            name: "VariantDef",
            description: "Definition of a variant in a discriminated union.",
            type: s.struct({
                fields: [
                    {
                        name: "name",
                        displayName: "Name",
                        type: s.string({}),
                        description: "The variant's discriminator value.",
                    },
                    {
                        name: "type",
                        displayName: "Type",
                        type: s.ref({ name: "TypeDef" }),
                        description: "The variant's payload type.",
                    },
                ],
            }),
        },
        {
            name: "UnionTypeDef",
            description: "A discriminated union type.",
            type: s.struct({
                fields: [
                    {
                        name: "variants",
                        displayName: "Variants",
                        type: s.list({ elementType: s.ref({ name: "VariantDef" }) }),
                    },
                ],
            }),
        },
        {
            name: "OptionalTypeDef",
            description: "Wraps a type to make it optional.",
            type: s.struct({
                fields: [
                    {
                        name: "type",
                        displayName: "Type",
                        type: s.ref({ name: "TypeDef" }),
                        description: "The wrapped type.",
                    },
                ],
            }),
        },
        {
            name: "ResultTypeDef",
            description: "A result type (ok or error).",
            type: s.struct({
                fields: [
                    {
                        name: "okType",
                        displayName: "Ok Type",
                        type: s.ref({ name: "TypeDef" }),
                        description: "The type of the success value.",
                    },
                    {
                        name: "errType",
                        displayName: "Error Type",
                        type: s.ref({ name: "TypeDef" }),
                        description: "The type of the error value.",
                    },
                ],
            }),
        },
        {
            name: "TypeRef",
            description: "A reference to a named type.",
            type: s.struct({
                fields: [
                    {
                        name: "name",
                        displayName: "Name",
                        type: s.string({}),
                        description: "The name of the referenced type.",
                    },
                ],
            }),
        },
        {
            name: "TypeDef",
            description:
                "A type definition. Can be a primitive, collection, struct, union, optional, result, or reference.",
            type: s.union({
                variants: [
                    { name: "string", type: s.ref({ name: "StringTypeDef" }) },
                    { name: "boolean", type: s.ref({ name: "BooleanTypeDef" }) },
                    { name: "integer", type: s.ref({ name: "IntegerTypeDef" }) },
                    { name: "float", type: s.ref({ name: "FloatTypeDef" }) },
                    { name: "double", type: s.ref({ name: "DoubleTypeDef" }) },
                    { name: "date", type: s.ref({ name: "DateTypeDef" }) },
                    { name: "timestamp", type: s.ref({ name: "TimestampTypeDef" }) },
                    { name: "geopoint", type: s.ref({ name: "GeopointTypeDef" }) },
                    { name: "attachment", type: s.ref({ name: "AttachmentTypeDef" }) },
                    { name: "list", type: s.ref({ name: "ListTypeDef" }) },
                    { name: "map", type: s.ref({ name: "MapTypeDef" }) },
                    { name: "struct", type: s.ref({ name: "StructTypeDef" }) },
                    { name: "union", type: s.ref({ name: "UnionTypeDef" }) },
                    { name: "optional", type: s.ref({ name: "OptionalTypeDef" }) },
                    { name: "result", type: s.ref({ name: "ResultTypeDef" }) },
                    { name: "ref", type: s.ref({ name: "TypeRef" }) },
                ],
            }),
        },
        {
            name: "NamedTypeDef",
            description: "A named type definition that can be referenced by other types.",
            type: s.struct({
                fields: [
                    {
                        name: "name",
                        displayName: "Name",
                        type: s.string({}),
                        description: "The type's name for use in code.",
                    },
                    {
                        name: "description",
                        displayName: "Description",
                        type: s.optional({ type: s.string({}) }),
                        description: "Optional documentation for the type.",
                    },
                    {
                        name: "deprecated",
                        displayName: "Deprecated?",
                        type: s.optional({ type: s.ref({ name: "Deprecation" }) }),
                    },
                    {
                        name: "type",
                        displayName: "Type",
                        type: s.ref({ name: "TypeDef" }),
                        description: "The type definition.",
                    },
                ],
            }),
        },
        {
            name: "SchemaIR",
            description: "The root schema containing all type definitions.",
            type: s.struct({
                fields: [
                    {
                        name: "types",
                        displayName: "Types",
                        type: s.list({ elementType: s.ref({ name: "NamedTypeDef" }) }),
                        description: "All named types in the schema.",
                    },
                ],
            }),
        },
    ],
} satisfies SchemaIR;
