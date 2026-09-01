import { o } from "./generated/builders.js";
import type { OntologyIR } from "./generated/types.js";

export default {
    types: [
        {
            name: "Deprecation",
            type: o.struct({
                fields: [
                    {
                        name: "message",
                        displayName: "Message",
                        type: o.string({}),
                    },
                ],
            }),
        },
        {
            name: "StringEnumConstraint",
            description: "Constrains a string to a set of allowed values.",
            type: o.struct({
                fields: [
                    {
                        name: "options",
                        displayName: "Options",
                        type: o.list({
                            elementType: o.struct({
                                fields: [
                                    { name: "value", displayName: "Value", type: o.string({}) },
                                    {
                                        name: "label",
                                        displayName: "Label",
                                        type: o.optional({ type: o.string({}) }),
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
            type: o.struct({
                fields: [
                    {
                        name: "regex",
                        displayName: "Regex",
                        type: o.string({}),
                    },
                ],
            }),
        },
        {
            name: "StringConstraint",
            description: "A constraint that can be applied to a string type.",
            type: o.union({
                variants: [
                    { name: "enum", type: o.ref({ name: "StringEnumConstraint" }) },
                    { name: "regex", type: o.ref({ name: "StringRegexConstraint" }) },
                ],
            }),
        },
        {
            name: "StringTypeDef",
            description: "A string type with optional constraints.",
            type: o.struct({
                fields: [
                    {
                        name: "constraint",
                        displayName: "Constraint",
                        type: o.optional({ type: o.ref({ name: "StringConstraint" }) }),
                    },
                ],
            }),
        },
        {
            name: "BooleanTypeDef",
            description: "A boolean type.",
            type: o.struct({ fields: [] }),
        },
        {
            name: "IntegerTypeDef",
            description: "A 32-bit integer type.",
            type: o.struct({ fields: [] }),
        },
        // TODO: Add a 64-bit integer ("long") type for integral values such as byte sizes.
        {
            name: "FloatTypeDef",
            description: "A 32-bit floating point type.",
            type: o.struct({ fields: [] }),
        },
        {
            name: "DoubleTypeDef",
            description: "A 64-bit floating point type.",
            type: o.struct({ fields: [] }),
        },
        {
            name: "DateTypeDef",
            description: "A date type (no time component).",
            type: o.struct({ fields: [] }),
        },
        {
            name: "TimestampTypeDef",
            description: "A timestamp type (instant in time).",
            type: o.struct({ fields: [] }),
        },
        {
            name: "GeopointTypeDef",
            description: "A geographic point (lat/lon).",
            type: o.struct({ fields: [] }),
        },
        {
            name: "UnknownTypeDef",
            description: "An opaque type whose shape is not known at schema time.",
            type: o.struct({ fields: [] }),
        },
        {
            name: "ListTypeDef",
            description: "A list/array type.",
            type: o.struct({
                fields: [
                    {
                        name: "elementType",
                        displayName: "Element Type",
                        type: o.ref({ name: "TypeDef" }),
                        description: "The type of elements in the list.",
                    },
                ],
            }),
        },
        {
            name: "MapTypeDef",
            description: "A map/record type.",
            type: o.struct({
                fields: [
                    {
                        name: "keyType",
                        displayName: "Key Type",
                        type: o.ref({ name: "TypeDef" }),
                        description: "The type of keys (must be string right now).",
                    },
                    {
                        name: "valueType",
                        displayName: "Value Type",
                        type: o.ref({ name: "TypeDef" }),
                        description: "The type of values.",
                    },
                ],
            }),
        },
        {
            name: "FieldDef",
            description: "Definition of a field in a struct.",
            type: o.struct({
                fields: [
                    {
                        name: "name",
                        displayName: "Name",
                        type: o.string({}),
                        description: "The field name in code.",
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
                        type: o.ref({ name: "TypeDef" }),
                        description: "The field's type.",
                    },
                    {
                        name: "description",
                        displayName: "Description",
                        type: o.optional({ type: o.string({}) }),
                        description: "Optional description.",
                    },
                    {
                        name: "deprecated",
                        displayName: "Deprecated?",
                        type: o.optional({ type: o.ref({ name: "Deprecation" }) }),
                    },
                ],
            }),
        },
        {
            name: "StructTypeDef",
            description: "A struct type with named fields.",
            type: o.struct({
                fields: [
                    {
                        name: "fields",
                        displayName: "Fields",
                        type: o.list({ elementType: o.ref({ name: "FieldDef" }) }),
                    },
                ],
            }),
        },
        {
            name: "VariantDef",
            description: "Definition of a variant in a discriminated union.",
            type: o.struct({
                fields: [
                    {
                        name: "name",
                        displayName: "Name",
                        type: o.string({}),
                        description: "The variant's discriminator value.",
                    },
                    {
                        name: "type",
                        displayName: "Type",
                        type: o.ref({ name: "TypeDef" }),
                        description: "The variant's payload type.",
                    },
                ],
            }),
        },
        {
            name: "UnionTypeDef",
            description: "A discriminated union type.",
            type: o.struct({
                fields: [
                    {
                        name: "variants",
                        displayName: "Variants",
                        type: o.list({ elementType: o.ref({ name: "VariantDef" }) }),
                    },
                ],
            }),
        },
        {
            name: "OptionalTypeDef",
            description: "Wraps a type to make it optional.",
            type: o.struct({
                fields: [
                    {
                        name: "type",
                        displayName: "Type",
                        type: o.ref({ name: "TypeDef" }),
                        description: "The wrapped type.",
                    },
                ],
            }),
        },
        {
            name: "ResultTypeDef",
            description: "A result type (ok or error).",
            type: o.struct({
                fields: [
                    {
                        name: "okType",
                        displayName: "Ok Type",
                        type: o.ref({ name: "TypeDef" }),
                        description: "The type of the success value.",
                    },
                    {
                        name: "errType",
                        displayName: "Error Type",
                        type: o.ref({ name: "TypeDef" }),
                        description: "The type of the error value.",
                    },
                ],
            }),
        },
        {
            name: "TypeRef",
            description: "A reference to a named type.",
            type: o.struct({
                fields: [
                    {
                        name: "name",
                        displayName: "Name",
                        type: o.string({}),
                        description: "The name of the referenced type.",
                    },
                ],
            }),
        },
        {
            name: "TypeDef",
            description:
                "A type definition. Can be a primitive, collection, struct, union, optional, result, or reference.",
            type: o.union({
                variants: [
                    { name: "string", type: o.ref({ name: "StringTypeDef" }) },
                    { name: "boolean", type: o.ref({ name: "BooleanTypeDef" }) },
                    { name: "integer", type: o.ref({ name: "IntegerTypeDef" }) },
                    { name: "float", type: o.ref({ name: "FloatTypeDef" }) },
                    { name: "double", type: o.ref({ name: "DoubleTypeDef" }) },
                    { name: "date", type: o.ref({ name: "DateTypeDef" }) },
                    { name: "timestamp", type: o.ref({ name: "TimestampTypeDef" }) },
                    { name: "geopoint", type: o.ref({ name: "GeopointTypeDef" }) },
                    { name: "list", type: o.ref({ name: "ListTypeDef" }) },
                    { name: "map", type: o.ref({ name: "MapTypeDef" }) },
                    { name: "struct", type: o.ref({ name: "StructTypeDef" }) },
                    { name: "union", type: o.ref({ name: "UnionTypeDef" }) },
                    { name: "optional", type: o.ref({ name: "OptionalTypeDef" }) },
                    { name: "result", type: o.ref({ name: "ResultTypeDef" }) },
                    { name: "ref", type: o.ref({ name: "TypeRef" }) },
                    { name: "attachment", type: o.ref({ name: "AttachmentTypeDef" }) },
                    { name: "objectReference", type: o.ref({ name: "ObjectReferenceTypeDef" }) },
                    { name: "unknown", type: o.ref({ name: "UnknownTypeDef" }) },
                ],
            }),
        },
        {
            name: "NamedTypeDef",
            description: "A named type definition that can be referenced by other types.",
            type: o.struct({
                fields: [
                    {
                        name: "name",
                        displayName: "Name",
                        type: o.string({}),
                        description: "The type's name for use in code.",
                    },
                    {
                        name: "description",
                        displayName: "Description",
                        type: o.optional({ type: o.string({}) }),
                        description: "Optional documentation for the type.",
                    },
                    {
                        name: "deprecated",
                        displayName: "Deprecated?",
                        type: o.optional({ type: o.ref({ name: "Deprecation" }) }),
                    },
                    {
                        name: "type",
                        displayName: "Type",
                        type: o.ref({ name: "TypeDef" }),
                        description: "The type definition.",
                    },
                ],
            }),
        },
        {
            name: "ImageMediaType",
            description: "A supported image media type.",
            type: o.string({
                constraint: o.StringConstraint.enum({
                    options: [
                        { value: "image/bmp", label: "BMP" },
                        { value: "image/tiff", label: "TIFF" },
                        { value: "image/nitf", label: "NITF" },
                        { value: "image/jp2", label: "JPEG 2000" },
                        { value: "image/jpeg", label: "JPEG" },
                        { value: "image/png", label: "PNG" },
                        { value: "image/gif", label: "GIF" },
                        { value: "image/svg+xml", label: "SVG" },
                        { value: "image/webp", label: "WebP" },
                    ],
                }),
            }),
        },
        {
            name: "DimensionsConstraint",
            description: "Constrains intrinsic pixel dimensions.",
            type: o.struct({
                fields: [
                    {
                        name: "width",
                        displayName: "Width",
                        type: o.optional({
                            type: o.struct({
                                fields: [
                                    {
                                        name: "min",
                                        displayName: "Minimum",
                                        type: o.optional({ type: o.integer({}) }),
                                    },
                                    {
                                        name: "max",
                                        displayName: "Maximum",
                                        type: o.optional({ type: o.integer({}) }),
                                    },
                                ],
                            }),
                        }),
                    },
                    {
                        name: "height",
                        displayName: "Height",
                        type: o.optional({
                            type: o.struct({
                                fields: [
                                    {
                                        name: "min",
                                        displayName: "Minimum",
                                        type: o.optional({ type: o.integer({}) }),
                                    },
                                    {
                                        name: "max",
                                        displayName: "Maximum",
                                        type: o.optional({ type: o.integer({}) }),
                                    },
                                ],
                            }),
                        }),
                    },
                ],
            }),
        },
        {
            name: "ImageAttachmentConstraint",
            description: "Constraints specific to image attachments.",
            type: o.struct({
                fields: [
                    {
                        name: "mediaTypes",
                        displayName: "Media types",
                        type: o.optional({
                            type: o.list({ elementType: o.ref({ name: "ImageMediaType" }) }),
                        }),
                    },
                    {
                        name: "dimensions",
                        displayName: "Dimensions",
                        type: o.optional({
                            type: o.ref({ name: "DimensionsConstraint" }),
                        }),
                    },
                ],
            }),
        },
        {
            name: "AttachmentContentConstraint",
            description: "Content-specific attachment constraints.",
            type: o.union({
                variants: [
                    {
                        name: "image",
                        type: o.ref({ name: "ImageAttachmentConstraint" }),
                    },
                ],
            }),
        },
        {
            name: "AttachmentConstraint",
            description: "Constraints applied to an attachment.",
            type: o.struct({
                fields: [
                    {
                        name: "size",
                        displayName: "Size",
                        type: o.optional({
                            type: o.struct({
                                fields: [
                                    {
                                        name: "min",
                                        displayName: "Minimum",
                                        type: o.optional({ type: o.double({}) }),
                                    },
                                    {
                                        name: "max",
                                        displayName: "Maximum",
                                        type: o.optional({ type: o.double({}) }),
                                    },
                                ],
                            }),
                        }),
                    },
                    {
                        name: "content",
                        displayName: "Content",
                        type: o.optional({
                            type: o.ref({ name: "AttachmentContentConstraint" }),
                        }),
                    },
                ],
            }),
        },
        {
            name: "AttachmentTypeDef",
            description: "A file handle with optional constraints.",
            type: o.struct({
                fields: [
                    {
                        name: "constraint",
                        displayName: "Constraint",
                        type: o.optional({ type: o.ref({ name: "AttachmentConstraint" }) }),
                    },
                    {
                        name: "meta",
                        displayName: "Meta",
                        type: o.optional({
                            type: o.map({ keyType: o.string({}), valueType: o.unknown({}) }),
                        }),
                    },
                ],
            }),
        },
        {
            name: "ObjectReferenceTypeDef",
            description: "A reference to an ontology object type.",
            type: o.struct({
                fields: [
                    {
                        name: "objectType",
                        displayName: "Object type",
                        type: o.string({}),
                        description: "The referenced object type name.",
                    },
                ],
            }),
        },
        {
            name: "PropertyDef",
            description: "A property on an Object type.",
            type: o.struct({
                fields: [
                    {
                        name: "name",
                        displayName: "Name",
                        type: o.string({}),
                        description: "The property's name.",
                    },
                    {
                        name: "displayName",
                        displayName: "Display name",
                        type: o.string({}),
                        description: "Human-readable name.",
                    },
                    {
                        name: "type",
                        displayName: "Type",
                        type: o.ref({ name: "TypeDef" }),
                        description: "The property's type.",
                    },
                    {
                        name: "description",
                        displayName: "Description",
                        type: o.optional({ type: o.string({}) }),
                        description: "Optional description.",
                    },
                    {
                        name: "deprecated",
                        displayName: "Deprecated?",
                        type: o.optional({ type: o.ref({ name: "Deprecation" }) }),
                    },
                ],
            }),
        },
        {
            name: "ObjectTypeDef",
            description: "An object type in the ontology.",
            type: o.struct({
                fields: [
                    {
                        name: "name",
                        displayName: "Name",
                        type: o.string({}),
                        description: "The object type's programmatic name.",
                    },
                    {
                        name: "displayName",
                        displayName: "Display name",
                        type: o.string({}),
                        description: "Human-readable name.",
                    },
                    {
                        name: "pluralDisplayName",
                        displayName: "Plural display name",
                        type: o.string({}),
                    },
                    {
                        name: "primaryKey",
                        displayName: "Primary key",
                        type: o.string({}),
                        description: "The name of the property that serves as primary key.",
                    },
                    {
                        name: "title",
                        displayName: "Title",
                        type: o.optional({ type: o.string({}) }),
                        description:
                            "The optional property name used as the human-readable title for an object.",
                    },
                    {
                        name: "properties",
                        displayName: "Properties",
                        type: o.list({ elementType: o.ref({ name: "PropertyDef" }) }),
                        description: "The object type's propertieo.",
                    },
                    {
                        name: "description",
                        displayName: "Description",
                        type: o.optional({ type: o.string({}) }),
                        description: "Optional description.",
                    },
                    {
                        name: "deprecated",
                        displayName: "Deprecated?",
                        type: o.optional({ type: o.ref({ name: "Deprecation" }) }),
                    },
                ],
            }),
        },
        {
            name: "LinkTypeSideDef",
            type: o.struct({
                fields: [
                    {
                        name: "objectType",
                        displayName: "Object type",
                        type: o.string({}),
                    },
                    {
                        name: "name",
                        displayName: "Name",
                        type: o.string({}),
                    },
                    {
                        name: "displayName",
                        displayName: "Display name",
                        type: o.string({}),
                    },
                ],
            }),
        },
        {
            name: "LinkCardinality",
            description: "The cardinality of a link from the source's perspective.",
            type: o.string({
                constraint: o.StringConstraint.enum({
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
            type: o.struct({
                fields: [
                    {
                        name: "id",
                        displayName: "ID",
                        type: o.string({}),
                    },
                    {
                        name: "source",
                        displayName: "Source",
                        type: o.ref({ name: "LinkTypeSideDef" }),
                    },
                    {
                        name: "target",
                        displayName: "Target",
                        type: o.ref({ name: "LinkTypeSideDef" }),
                    },
                    {
                        name: "foreignKey",
                        displayName: "Foreign key",
                        type: o.string({}),
                        description: "The foreign key on the source.",
                    },
                    {
                        name: "cardinality",
                        displayName: "Cardinality",
                        type: o.string({
                            constraint: o.StringConstraint.enum({
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
            name: "ActionParameterDef",
            description: "A parameter of an Action type.",
            type: o.struct({
                fields: [
                    {
                        name: "name",
                        displayName: "Name",
                        type: o.string({}),
                        description: "The parameter's name.",
                    },
                    {
                        name: "displayName",
                        displayName: "Display name",
                        type: o.string({}),
                        description: "Human-readable name.",
                    },
                    {
                        name: "type",
                        displayName: "Type",
                        type: o.ref({ name: "TypeDef" }),
                        description: "The parameter's type.",
                    },
                    {
                        name: "description",
                        displayName: "Description",
                        type: o.optional({ type: o.string({}) }),
                        description: "Optional description.",
                    },
                    {
                        name: "deprecated",
                        displayName: "Deprecated?",
                        type: o.optional({ type: o.ref({ name: "Deprecation" }) }),
                    },
                    {
                        name: "defaultValue",
                        displayName: "Default value",
                        type: o.optional({ type: o.ref({ name: "Expression" }) }),
                        description: "The expression used when the caller does not provide a value.",
                    },
                ],
            }),
        },
        {
            name: "ValueReferenceExpression",
            description: "Reads a value from scope by path.",
            type: o.struct({
                fields: [
                    {
                        name: "path",
                        displayName: "Path",
                        type: o.list({ elementType: o.string({}) }),
                    },
                ],
            }),
        },
        {
            name: "ContextReferenceExpression",
            description: "Reads a value from context by path.",
            type: o.struct({
                fields: [
                    {
                        name: "path",
                        displayName: "Path",
                        type: o.list({ elementType: o.string({}) }),
                    },
                ],
            }),
        },
        {
            name: "UuidFunctionCall",
            description: "Generates a UUID value.",
            type: o.struct({
                fields: [],
            }),
        },
        {
            name: "NowFunctionCall",
            description: "Returns the current timestamp.",
            type: o.struct({
                fields: [],
            }),
        },
        {
            name: "LiteralExpression",
            description: "A static literal value.",
            type: o.struct({
                fields: [
                    {
                        name: "value",
                        displayName: "Value",
                        type: o.unknown({}),
                        description: "The literal value.",
                    },
                ],
            }),
        },
        {
            name: "ObjectQueryEqualsPredicate",
            description: "Matches an object property equal to a value.",
            type: o.struct({
                fields: [
                    {
                        name: "property",
                        displayName: "Property",
                        type: o.list({ elementType: o.string({}) }),
                    },
                    {
                        name: "value",
                        displayName: "Value",
                        type: o.unknown({}),
                    },
                ],
            }),
        },
        {
            name: "ObjectQueryInPredicate",
            description: "Matches an object property equal to one of several values.",
            type: o.struct({
                fields: [
                    {
                        name: "property",
                        displayName: "Property",
                        type: o.list({ elementType: o.string({}) }),
                    },
                    {
                        name: "values",
                        displayName: "Values",
                        type: o.list({ elementType: o.unknown({}) }),
                    },
                ],
            }),
        },
        {
            name: "ObjectQueryRangePredicate",
            description: "Matches an object property within a range.",
            type: o.struct({
                fields: [
                    {
                        name: "property",
                        displayName: "Property",
                        type: o.list({ elementType: o.string({}) }),
                    },
                    {
                        name: "lt",
                        displayName: "Less than",
                        type: o.optional({ type: o.unknown({}) }),
                    },
                    {
                        name: "lte",
                        displayName: "Less than or equal",
                        type: o.optional({ type: o.unknown({}) }),
                    },
                    {
                        name: "gt",
                        displayName: "Greater than",
                        type: o.optional({ type: o.unknown({}) }),
                    },
                    {
                        name: "gte",
                        displayName: "Greater than or equal",
                        type: o.optional({ type: o.unknown({}) }),
                    },
                ],
            }),
        },
        {
            name: "ObjectQueryLogicalPredicate",
            description: "Combines object-query predicates.",
            type: o.struct({
                fields: [
                    {
                        name: "predicates",
                        displayName: "Predicates",
                        type: o.list({
                            elementType: o.ref({ name: "ObjectQueryPredicate" }),
                        }),
                    },
                ],
            }),
        },
        {
            name: "ObjectQueryNotPredicate",
            description: "Negates an object-query predicate.",
            type: o.struct({
                fields: [
                    {
                        name: "predicate",
                        displayName: "Predicate",
                        type: o.ref({ name: "ObjectQueryPredicate" }),
                    },
                ],
            }),
        },
        {
            name: "ObjectQueryPredicate",
            description: "A provider-neutral predicate used to query ontology objects.",
            type: o.union({
                variants: [
                    {
                        name: "eq",
                        type: o.ref({ name: "ObjectQueryEqualsPredicate" }),
                    },
                    {
                        name: "in",
                        type: o.ref({ name: "ObjectQueryInPredicate" }),
                    },
                    {
                        name: "range",
                        type: o.ref({ name: "ObjectQueryRangePredicate" }),
                    },
                    {
                        name: "and",
                        type: o.ref({ name: "ObjectQueryLogicalPredicate" }),
                    },
                    {
                        name: "or",
                        type: o.ref({ name: "ObjectQueryLogicalPredicate" }),
                    },
                    {
                        name: "not",
                        type: o.ref({ name: "ObjectQueryNotPredicate" }),
                    },
                ],
            }),
        },
        {
            name: "ObjectQueryExpression",
            description: "Returns the primary key when exactly one object matches a predicate.",
            type: o.struct({
                fields: [
                    {
                        name: "objectType",
                        displayName: "Object type",
                        type: o.string({}),
                    },
                    {
                        name: "where",
                        displayName: "Where",
                        type: o.optional({
                            type: o.ref({ name: "ObjectQueryPredicate" }),
                        }),
                    },
                ],
            }),
        },
        {
            name: "FunctionCallExpression",
            description: "Calls a function within an expression.",
            type: o.union({
                variants: [
                    { name: "uuid", type: o.ref({ name: "UuidFunctionCall" }) },
                    { name: "now", type: o.ref({ name: "NowFunctionCall" }) },
                ],
            }),
        },
        {
            name: "Expression",
            description: "An expression that resolves to a value.",
            type: o.union({
                variants: [
                    {
                        name: "valueReference",
                        type: o.ref({ name: "ValueReferenceExpression" }),
                    },
                    {
                        name: "contextReference",
                        type: o.ref({ name: "ContextReferenceExpression" }),
                    },
                    {
                        name: "functionCall",
                        type: o.ref({ name: "FunctionCallExpression" }),
                    },
                    {
                        name: "literal",
                        type: o.ref({ name: "LiteralExpression" }),
                    },
                    {
                        name: "objectQuery",
                        type: o.ref({ name: "ObjectQueryExpression" }),
                    },
                ],
            }),
        },
        {
            name: "PropertyAssignment",
            description: "Assigns an expression to a property path on an object written by an action.",
            type: o.struct({
                fields: [
                    {
                        name: "property",
                        displayName: "Property",
                        type: o.list({ elementType: o.string({}) }),
                    },
                    {
                        name: "value",
                        displayName: "Value",
                        type: o.ref({ name: "Expression" }),
                    },
                ],
            }),
        },
        {
            name: "CreateObjectActionLogicStep",
            description: "Creates an object and assigns property values.",
            type: o.struct({
                fields: [
                    {
                        name: "objectType",
                        displayName: "Object type",
                        type: o.string({}),
                    },
                    {
                        name: "values",
                        displayName: "Values",
                        type: o.list({ elementType: o.ref({ name: "PropertyAssignment" }) }),
                    },
                ],
            }),
        },
        {
            name: "UpdateObjectActionLogicStep",
            description: "Updates a referenced object and assigns property values.",
            type: o.struct({
                fields: [
                    {
                        name: "object",
                        displayName: "Object",
                        type: o.ref({ name: "ValueReferenceExpression" }),
                    },
                    {
                        name: "values",
                        displayName: "Values",
                        type: o.list({ elementType: o.ref({ name: "PropertyAssignment" }) }),
                    },
                ],
            }),
        },
        {
            name: "DeleteObjectActionLogicStep",
            description: "Deletes a referenced object.",
            type: o.struct({
                fields: [
                    {
                        name: "object",
                        displayName: "Object",
                        type: o.ref({ name: "ValueReferenceExpression" }),
                    },
                ],
            }),
        },
        {
            name: "ActionLogicStep",
            description: "A logic step performed by an action.",
            type: o.union({
                variants: [
                    {
                        name: "createObject",
                        type: o.ref({ name: "CreateObjectActionLogicStep" }),
                    },
                    {
                        name: "updateObject",
                        type: o.ref({ name: "UpdateObjectActionLogicStep" }),
                    },
                    {
                        name: "deleteObject",
                        type: o.ref({ name: "DeleteObjectActionLogicStep" }),
                    },
                ],
            }),
        },
        {
            name: "ActionTypeDef",
            description: "An action type in the ontology.",
            type: o.struct({
                fields: [
                    {
                        name: "name",
                        displayName: "Name",
                        type: o.string({}),
                        description: "The object type's programmatic name.",
                    },
                    {
                        name: "displayName",
                        displayName: "Display name",
                        type: o.string({}),
                        description: "Human-readable name.",
                    },
                    {
                        name: "parameters",
                        displayName: "Parameters",
                        type: o.list({ elementType: o.ref({ name: "ActionParameterDef" }) }),
                        description: "The action type's parametero.",
                    },
                    {
                        name: "logic",
                        displayName: "Logic",
                        type: o.list({ elementType: o.ref({ name: "ActionLogicStep" }) }),
                        description: "The action type's local logic stepo.",
                    },
                    {
                        name: "description",
                        displayName: "Description",
                        type: o.optional({ type: o.string({}) }),
                        description: "Optional description.",
                    },
                    {
                        name: "deprecated",
                        displayName: "Deprecated?",
                        type: o.optional({ type: o.ref({ name: "Deprecation" }) }),
                    },
                ],
            }),
        },
        {
            name: "QueryFunctionParameterDef",
            description: "A parameter accepted by a query function type.",
            type: o.struct({
                fields: [
                    {
                        name: "name",
                        displayName: "Name",
                        type: o.string({}),
                        description: "The query function parameter's programmatic name.",
                    },
                    {
                        name: "displayName",
                        displayName: "Display name",
                        type: o.string({}),
                        description: "Human-readable name.",
                    },
                    {
                        name: "type",
                        displayName: "Type",
                        type: o.ref({ name: "TypeDef" }),
                    },
                    {
                        name: "description",
                        displayName: "Description",
                        type: o.optional({ type: o.string({}) }),
                        description: "Optional description.",
                    },
                    {
                        name: "deprecated",
                        displayName: "Deprecated?",
                        type: o.optional({ type: o.ref({ name: "Deprecation" }) }),
                    },
                ],
            }),
        },
        {
            name: "QueryFunctionTypeDef",
            description: "A runnable query function type in the ontology.",
            type: o.struct({
                fields: [
                    {
                        name: "name",
                        displayName: "Name",
                        type: o.string({}),
                        description: "The query function type's programmatic name.",
                    },
                    {
                        name: "displayName",
                        displayName: "Display name",
                        type: o.string({}),
                        description: "Human-readable name.",
                    },
                    {
                        name: "parameters",
                        displayName: "Parameters",
                        type: o.list({ elementType: o.ref({ name: "QueryFunctionParameterDef" }) }),
                        description: "The query function type's parameters.",
                    },
                    {
                        name: "returnType",
                        displayName: "Return type",
                        type: o.ref({ name: "TypeDef" }),
                        description: "The query function type's return type.",
                    },
                    {
                        name: "description",
                        displayName: "Description",
                        type: o.optional({ type: o.string({}) }),
                        description: "Optional description.",
                    },
                    {
                        name: "deprecated",
                        displayName: "Deprecated?",
                        type: o.optional({ type: o.ref({ name: "Deprecation" }) }),
                    },
                ],
            }),
        },
        {
            name: "MoveLensOp",
            description: "Moves a property from one path to another.",
            type: o.struct({
                fields: [
                    {
                        name: "from",
                        displayName: "From",
                        type: o.list({ elementType: o.string({}) }),
                    },
                    {
                        name: "to",
                        displayName: "To",
                        type: o.list({ elementType: o.string({}) }),
                    },
                ],
            }),
        },
        {
            name: "SelectLensOp",
            description: "Retains only the selected top-level properties.",
            type: o.struct({
                fields: [
                    {
                        name: "properties",
                        displayName: "Properties",
                        type: o.list({ elementType: o.string({}) }),
                    },
                ],
            }),
        },
        {
            name: "LensOp",
            description: "One schema and value transformation operation.",
            type: o.union({
                variants: [
                    { name: "move", type: o.ref({ name: "MoveLensOp" }) },
                    { name: "select", type: o.ref({ name: "SelectLensOp" }) },
                ],
            }),
        },
        {
            name: "Lens",
            description: "An ordered sequence of source-to-target transformation operations.",
            type: o.struct({
                fields: [
                    {
                        name: "operations",
                        displayName: "Operations",
                        type: o.list({ elementType: o.ref({ name: "LensOp" }) }),
                    },
                ],
            }),
        },
        {
            name: "OntologyIR",
            description: "The root ontology definition containing all type definitions.",
            type: o.struct({
                fields: [
                    {
                        name: "types",
                        displayName: "Named types",
                        type: o.list({ elementType: o.ref({ name: "NamedTypeDef" }) }),
                        description: "Named, reusable value types.",
                    },
                    {
                        name: "objectTypes",
                        displayName: "Object types",
                        type: o.list({ elementType: o.ref({ name: "ObjectTypeDef" }) }),
                        description: "Object type definitions.",
                    },
                    {
                        name: "linkTypes",
                        displayName: "Link types",
                        type: o.list({ elementType: o.ref({ name: "LinkTypeDef" }) }),
                        description: "Relationship definitions between object types.",
                    },
                    {
                        name: "actionTypes",
                        displayName: "Action types",
                        type: o.list({ elementType: o.ref({ name: "ActionTypeDef" }) }),
                        description: "Action type definitions.",
                    },
                    {
                        name: "queryFunctionTypes",
                        displayName: "Query function types",
                        type: o.list({ elementType: o.ref({ name: "QueryFunctionTypeDef" }) }),
                        description: "Query function type definitions.",
                    },
                    {
                        name: "contextType",
                        displayName: "Context type",
                        type: o.optional({ type: o.ref({ name: "TypeDef" }) }),
                        description: "Optional typed execution context available to ontology expressions.",
                    },
                ],
            }),
        },
    ],
    objectTypes: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
} satisfies OntologyIR;
