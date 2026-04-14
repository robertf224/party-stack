import { s, SchemaIRSchema } from "@party-stack/schema";
import type { SchemaIR, UnionTypeDef } from "@party-stack/schema";

const schemaTypes = SchemaIRSchema.types.filter((type) => type.name !== "SchemaIR");
const typeDef = schemaTypes.find((type) => type.name === "TypeDef")!;
(typeDef.type.value as UnionTypeDef).variants.push({
    name: "objectReference",
    type: s.ref({ name: "ObjectReferenceTypeDef" }),
});

export default {
    types: [
        ...schemaTypes,
        {
            name: "ObjectReferenceTypeDef",
            description: "A reference to an ontology object type.",
            type: s.struct({
                fields: [
                    {
                        name: "objectType",
                        displayName: "Object type",
                        type: s.string({}),
                        description: "The referenced object type name.",
                    },
                ],
            }),
        },
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
                    {
                        name: "meta",
                        displayName: "Meta",
                        type: s.optional({
                            type: s.map({ keyType: s.string({}), valueType: s.unknown({}) }),
                        }),
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
            name: "ActionParameterDef",
            description: "A parameter of an Action type.",
            type: s.struct({
                fields: [
                    {
                        name: "name",
                        displayName: "Name",
                        type: s.string({}),
                        description: "The parameter's name.",
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
                        description: "The parameter's type.",
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
                    {
                        name: "defaultValue",
                        displayName: "Default value",
                        type: s.optional({ type: s.ref({ name: "Expression" }) }),
                        description: "The expression used when the caller does not provide a value.",
                    },
                ],
            }),
        },
        {
            name: "ValueReferenceExpression",
            description: "Reads a value from scope by path.",
            type: s.struct({
                fields: [
                    {
                        name: "path",
                        displayName: "Path",
                        type: s.list({ elementType: s.string({}) }),
                    },
                ],
            }),
        },
        {
            name: "ContextReferenceExpression",
            description: "Reads a value from context by path.",
            type: s.struct({
                fields: [
                    {
                        name: "path",
                        displayName: "Path",
                        type: s.list({ elementType: s.string({}) }),
                    },
                ],
            }),
        },
        {
            name: "UuidFunctionCall",
            description: "Generates a UUID value.",
            type: s.struct({
                fields: [],
            }),
        },
        {
            name: "NowFunctionCall",
            description: "Returns the current timestamp.",
            type: s.struct({
                fields: [],
            }),
        },
        {
            name: "LiteralExpression",
            description: "A static literal value.",
            type: s.struct({
                fields: [
                    {
                        name: "value",
                        displayName: "Value",
                        type: s.unknown({}),
                        description: "The literal value.",
                    },
                ],
            }),
        },
        {
            name: "FunctionCallExpression",
            description: "Calls a function within an expression.",
            type: s.union({
                variants: [
                    { name: "uuid", type: s.ref({ name: "UuidFunctionCall" }) },
                    { name: "now", type: s.ref({ name: "NowFunctionCall" }) },
                ],
            }),
        },
        {
            name: "Expression",
            description: "An expression that resolves to a value.",
            type: s.union({
                variants: [
                    {
                        name: "valueReference",
                        type: s.ref({ name: "ValueReferenceExpression" }),
                    },
                    {
                        name: "contextReference",
                        type: s.ref({ name: "ContextReferenceExpression" }),
                    },
                    {
                        name: "functionCall",
                        type: s.ref({ name: "FunctionCallExpression" }),
                    },
                    {
                        name: "literal",
                        type: s.ref({ name: "LiteralExpression" }),
                    },
                ],
            }),
        },
        {
            name: "PropertyAssignment",
            description: "Assigns an expression to a property path on an object written by an action.",
            type: s.struct({
                fields: [
                    {
                        name: "property",
                        displayName: "Property",
                        type: s.list({ elementType: s.string({}) }),
                    },
                    {
                        name: "value",
                        displayName: "Value",
                        type: s.ref({ name: "Expression" }),
                    },
                ],
            }),
        },
        {
            name: "CreateObjectActionLogicStep",
            description: "Creates an object and assigns property values.",
            type: s.struct({
                fields: [
                    {
                        name: "objectType",
                        displayName: "Object type",
                        type: s.string({}),
                    },
                    {
                        name: "values",
                        displayName: "Values",
                        type: s.list({ elementType: s.ref({ name: "PropertyAssignment" }) }),
                    },
                ],
            }),
        },
        {
            name: "UpdateObjectActionLogicStep",
            description: "Updates a referenced object and assigns property values.",
            type: s.struct({
                fields: [
                    {
                        name: "object",
                        displayName: "Object",
                        type: s.ref({ name: "ValueReferenceExpression" }),
                    },
                    {
                        name: "values",
                        displayName: "Values",
                        type: s.list({ elementType: s.ref({ name: "PropertyAssignment" }) }),
                    },
                ],
            }),
        },
        {
            name: "DeleteObjectActionLogicStep",
            description: "Deletes a referenced object.",
            type: s.struct({
                fields: [
                    {
                        name: "object",
                        displayName: "Object",
                        type: s.ref({ name: "ValueReferenceExpression" }),
                    },
                ],
            }),
        },
        {
            name: "ActionLogicStep",
            description: "A logic step performed by an action.",
            type: s.union({
                variants: [
                    {
                        name: "createObject",
                        type: s.ref({ name: "CreateObjectActionLogicStep" }),
                    },
                    {
                        name: "updateObject",
                        type: s.ref({ name: "UpdateObjectActionLogicStep" }),
                    },
                    {
                        name: "deleteObject",
                        type: s.ref({ name: "DeleteObjectActionLogicStep" }),
                    },
                ],
            }),
        },
        {
            name: "ActionTypeDef",
            description: "An action type in the ontology.",
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
                        name: "parameters",
                        displayName: "Parameters",
                        type: s.list({ elementType: s.ref({ name: "ActionParameterDef" }) }),
                        description: "The action type's parameters.",
                    },
                    {
                        name: "logic",
                        displayName: "Logic",
                        type: s.list({ elementType: s.ref({ name: "ActionLogicStep" }) }),
                        description: "The action type's local logic steps.",
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
                    {
                        name: "actionTypes",
                        displayName: "Action types",
                        type: s.list({ elementType: s.ref({ name: "ActionTypeDef" }) }),
                        description: "Action type definitions.",
                    },
                ],
            }),
        },
    ],
} satisfies SchemaIR;
