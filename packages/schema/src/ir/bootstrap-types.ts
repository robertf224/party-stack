import { Union } from "../utils/index.js";

/* eslint-disable @typescript-eslint/no-empty-object-type */
export interface StringEnumConstraint {
    options: Array<{
        value: string;
        label?: string;
    }>;
}

export interface StringRegexConstraint {
    regex: string;
}

export type StringConstraint = Union<{
    enum: StringEnumConstraint;
    regex: StringRegexConstraint;
}>;

export interface StringTypeDef {
    constraint?: StringConstraint;
}

export interface BooleanTypeDef {}

export interface IntegerTypeDef {}

export interface FloatTypeDef {}

export interface DoubleTypeDef {}

export interface DateTypeDef {}

export interface TimestampTypeDef {}

export interface GeopointTypeDef {}

export interface ListTypeDef {
    elementType: TypeDef;
}

export interface MapTypeDef {
    keyType: TypeDef;
    valueType: TypeDef;
}

export interface FieldDef {
    id?: string;
    name: string;
    type: TypeDef;
    displayName: string;
    description?: string;
}

export interface StructTypeDef {
    fields: FieldDef[];
}

export interface VariantDef {
    name: string;
    type: TypeDef;
}

export interface UnionTypeDef {
    variants: VariantDef[];
}

export interface OptionalTypeDef {
    type: TypeDef;
}

export interface ResultTypeDef {
    okType: TypeDef;
    errType: TypeDef;
}

export interface TypeRef {
    name: string;
}

export type TypeDef = Union<{
    string: StringTypeDef;
    boolean: BooleanTypeDef;
    integer: IntegerTypeDef;
    float: FloatTypeDef;
    double: DoubleTypeDef;
    date: DateTypeDef;
    timestamp: TimestampTypeDef;
    geopoint: GeopointTypeDef;
    list: ListTypeDef;
    map: MapTypeDef;
    struct: StructTypeDef;
    union: UnionTypeDef;
    optional: OptionalTypeDef;
    result: ResultTypeDef;
    ref: TypeRef;
}>;

export interface NamedTypeDef {
    name: string;
    description?: string;
    type: TypeDef;
}

export interface SchemaIR {
    types: NamedTypeDef[];
}
