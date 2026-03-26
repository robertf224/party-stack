// Auto-generated file - do not edit manually

import * as v from "../../utils/values.js";

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
export type AttachmentTypeDef = Record<never, never>;

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
}>;

/** A named type definition that can be referenced by other types. */
export type NamedTypeDef = {
    /** The type's name for use in code. */
    name: string;
    /** Optional documentation for the type. */
    description?: string;
    deprecated?: Deprecation;
    /** The type definition. */
    type: TypeDef;
};

/** The root schema containing all type definitions. */
export type SchemaIR = {
    /** All named types in the schema. */
    types: Array<NamedTypeDef>;
};
