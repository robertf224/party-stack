// Auto-generated file - do not edit manually

import * as v from "@party-stack/schema/values";

export type Deprecation = {
    message: string;
};

/** Constrains a string to a set of allowed values. */
export type StringEnumConstraint = {
    options: Array<{
        value: string;
        label?: string;
    }>;
};

/** Constrains a string to a regex. */
export type StringRegexConstraint = {
    regex: string;
};

/** A constraint that can be applied to a string type. */
export type StringConstraint = v.Union<{
    enum: StringEnumConstraint;
    regex: StringRegexConstraint;
}>;

/** A string type with optional constraints. */
export type StringTypeDef = {
    constraint?: StringConstraint;
};

/** A boolean type. */
export type BooleanTypeDef = Record<never, never>;

/** A 32-bit integer type. */
export type IntegerTypeDef = Record<never, never>;

/** A 32-bit floating point type. */
export type FloatTypeDef = Record<never, never>;

/** A 64-bit floating point type. */
export type DoubleTypeDef = Record<never, never>;

/** A date type (no time component). */
export type DateTypeDef = Record<never, never>;

/** A timestamp type (instant in time). */
export type TimestampTypeDef = Record<never, never>;

/** A geographic point (lat/lon). */
export type GeopointTypeDef = Record<never, never>;

/** A file handle. */
export type AttachmentTypeDef = {
    meta?: Record<string, unknown>;
};

/** An opaque type whose shape is not known at schema time. */
export type UnknownTypeDef = Record<never, never>;

/** A list/array type. */
export type ListTypeDef = {
    /** The type of elements in the list. */
    elementType: TypeDef;
};

/** A map/record type. */
export type MapTypeDef = {
    /** The type of keys (must be string right now). */
    keyType: TypeDef;
    /** The type of values. */
    valueType: TypeDef;
};

/** Definition of a field in a struct. */
export type FieldDef = {
    /** The field name in code. */
    name: string;
    /** Human-readable name. */
    displayName: string;
    /** The field's type. */
    type: TypeDef;
    /** Optional description. */
    description?: string;
    deprecated?: Deprecation;
};

/** A struct type with named fields. */
export type StructTypeDef = {
    fields: Array<FieldDef>;
};

/** Definition of a variant in a discriminated union. */
export type VariantDef = {
    /** The variant's discriminator value. */
    name: string;
    /** The variant's payload type. */
    type: TypeDef;
};

/** A discriminated union type. */
export type UnionTypeDef = {
    variants: Array<VariantDef>;
};

/** Wraps a type to make it optional. */
export type OptionalTypeDef = {
    /** The wrapped type. */
    type: TypeDef;
};

/** A result type (ok or error). */
export type ResultTypeDef = {
    /** The type of the success value. */
    okType: TypeDef;
    /** The type of the error value. */
    errType: TypeDef;
};

/** A reference to a named type. */
export type TypeRef = {
    /** The name of the referenced type. */
    name: string;
};

/** A type definition. Can be a primitive, collection, struct, union, optional, result, or reference. */
export type TypeDef = v.Union<{
    string: StringTypeDef;
    boolean: BooleanTypeDef;
    integer: IntegerTypeDef;
    float: FloatTypeDef;
    double: DoubleTypeDef;
    date: DateTypeDef;
    timestamp: TimestampTypeDef;
    geopoint: GeopointTypeDef;
    attachment: AttachmentTypeDef;
    list: ListTypeDef;
    map: MapTypeDef;
    struct: StructTypeDef;
    union: UnionTypeDef;
    optional: OptionalTypeDef;
    result: ResultTypeDef;
    ref: TypeRef;
    unknown: UnknownTypeDef;
    objectReference: ObjectReferenceTypeDef;
}>;

/** A reference to an ontology object type. */
export type ObjectReferenceTypeDef = {
    /** The referenced object type name. */
    objectType: string;
};

/** A property on an Object type. */
export type PropertyDef = {
    /** The property's name. */
    name: string;
    /** Human-readable name. */
    displayName: string;
    /** The property's type. */
    type: TypeDef;
    /** Optional description. */
    description?: string;
    deprecated?: Deprecation;
};

export type LinkTypeSideDef = {
    objectType: string;
    name: string;
    displayName: string;
};

/** The cardinality of a link from the source's perspective. */
export type LinkCardinality = "one" | "many";

/** A parameter of an Action type. */
export type ActionParameterDef = {
    /** The parameter's name. */
    name: string;
    /** Human-readable name. */
    displayName: string;
    /** The parameter's type. */
    type: TypeDef;
    /** Optional description. */
    description?: string;
    deprecated?: Deprecation;
    /** The expression used when the caller does not provide a value. */
    defaultValue?: Expression;
};

/** Reads a value from scope by path. */
export type ValueReferenceExpression = {
    path: Array<string>;
};

/** Reads a value from context by path. */
export type ContextReferenceExpression = {
    path: Array<string>;
};

/** Generates a UUID value. */
export type UuidFunctionCall = Record<never, never>;

/** Returns the current timestamp. */
export type NowFunctionCall = Record<never, never>;

/** A static literal value. */
export type LiteralExpression = {
    /** The literal value. */
    value: unknown;
};

/** Calls a function within an expression. */
export type FunctionCallExpression = v.Union<{
    uuid: UuidFunctionCall;
    now: NowFunctionCall;
}>;

/** An expression that resolves to a value. */
export type Expression = v.Union<{
    valueReference: ValueReferenceExpression;
    contextReference: ContextReferenceExpression;
    functionCall: FunctionCallExpression;
    literal: LiteralExpression;
}>;

/** Assigns an expression to a property path on an object written by an action. */
export type PropertyAssignment = {
    property: Array<string>;
    value: Expression;
};

/** Creates an object and assigns property values. */
export type CreateObjectActionLogicStep = {
    objectType: string;
    values: Array<PropertyAssignment>;
};

/** Updates a referenced object and assigns property values. */
export type UpdateObjectActionLogicStep = {
    object: ValueReferenceExpression;
    values: Array<PropertyAssignment>;
};

/** Deletes a referenced object. */
export type DeleteObjectActionLogicStep = {
    object: ValueReferenceExpression;
};

/** A logic step performed by an action. */
export type ActionLogicStep = v.Union<{
    createObject: CreateObjectActionLogicStep;
    updateObject: UpdateObjectActionLogicStep;
    deleteObject: DeleteObjectActionLogicStep;
}>;

/** A named type definition that can be referenced by other types. */
export type ValueType = {
    /** The type's name for use in code. */
    name: string;
    /** Optional documentation for the type. */
    description?: string;
    deprecated?: Deprecation;
    /** The type definition. */
    type: TypeDef;
};

/** An object type in the ontology. */
export type ObjectType = {
    /** The object type's programmatic name. */
    name: string;
    /** Human-readable name. */
    displayName: string;
    pluralDisplayName: string;
    /** The name of the property that serves as primary key. */
    primaryKey: string;
    /** The object type's properties. */
    properties: Array<PropertyDef>;
    /** Optional description. */
    description?: string;
    deprecated?: Deprecation;
};

/** A relationship between two object types. */
export type LinkType = {
    id: string;
    source: LinkTypeSideDef;
    target: LinkTypeSideDef;
    /** The foreign key on the source. */
    foreignKey: string;
    /** How many sources are linked to the target. */
    cardinality: "one" | "many";
};

/** An action type in the ontology. */
export type ActionType = {
    /** The object type's programmatic name. */
    name: string;
    /** Human-readable name. */
    displayName: string;
    /** The action type's parameters. */
    parameters: Array<ActionParameterDef>;
    /** The action type's local logic steps. */
    logic: Array<ActionLogicStep>;
    /** Optional description. */
    description?: string;
    deprecated?: Deprecation;
};

export type MetaOntology = {
    objectTypes: {
        ValueType: ValueType;
        ObjectType: ObjectType;
        LinkType: LinkType;
        ActionType: ActionType;
    };
    actionTypes: Record<never, never>;
};
