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
export type FileTypeDef = Record<never, never>;

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
    /** Optional unique identifier. */
    id?: string;
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

/** An attachment (stored file reference). */
export type AttachmentTypeDef = Record<never, never>;

/** A type definition. Extends the schema type system with attachment support. */
export type TypeDef = v.Union<{
    string: StringTypeDef;
    boolean: BooleanTypeDef;
    integer: IntegerTypeDef;
    float: FloatTypeDef;
    double: DoubleTypeDef;
    date: DateTypeDef;
    timestamp: TimestampTypeDef;
    geopoint: GeopointTypeDef;
    file: FileTypeDef;
    list: ListTypeDef;
    map: MapTypeDef;
    struct: StructTypeDef;
    union: UnionTypeDef;
    optional: OptionalTypeDef;
    result: ResultTypeDef;
    ref: TypeRef;
    attachment: AttachmentTypeDef;
}>;

/** A property on an object type. */
export type PropertyDef = {
    /** The property's programmatic name. */
    apiName: string;
    /** Human-readable name. */
    displayName: string;
    /** The property's type. */
    type: TypeDef;
    /** Optional description. */
    description?: string;
    deprecated?: Deprecation;
};

/** An object type in the ontology. */
export type ObjectTypeDef = {
    /** The object type's programmatic name. */
    apiName: string;
    /** Human-readable name. */
    displayName: string;
    /** The apiName of the property that serves as primary key. */
    primaryKey: string;
    /** The object type's properties. */
    properties: Array<PropertyDef>;
    /** Optional description. */
    description?: string;
    deprecated?: Deprecation;
};

/** A named, reusable value type shared across object types. */
export type ValueTypeDef = {
    /** The value type's programmatic name. */
    apiName: string;
    /** Human-readable name. */
    displayName: string;
    /** The value type's definition. */
    type: TypeDef;
    /** Optional description. */
    description?: string;
    deprecated?: Deprecation;
};

/** The cardinality of a link from the source's perspective. */
export type LinkCardinality = "one" | "many";

/** A relationship between two object types. */
export type LinkTypeDef = {
    /** The link type's programmatic name (from source's perspective). */
    apiName: string;
    /** Human-readable name. */
    displayName: string;
    /** The apiName of the source object type. */
    sourceObjectType: string;
    /** The apiName of the target object type. */
    targetObjectType: string;
    /** The cardinality from the source's perspective. */
    cardinality: LinkCardinality;
    /** Optional description. */
    description?: string;
    deprecated?: Deprecation;
};

/** The root ontology definition containing all type definitions. */
export type OntologyIR = {
    /** Named, reusable value types. */
    valueTypes: Array<ValueTypeDef>;
    /** Object type definitions. */
    objectTypes: Array<ObjectTypeDef>;
    /** Relationship definitions between object types. */
    linkTypes: Array<LinkTypeDef>;
};
