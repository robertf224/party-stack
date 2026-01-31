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

export type StringConstraint =
    | { kind: "enum"; value: StringEnumConstraint }
    | { kind: "regex"; value: StringRegexConstraint };

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

export type PrimitiveTypeDef =
    | { kind: "string"; value: StringTypeDef }
    | { kind: "boolean"; value: BooleanTypeDef }
    | { kind: "integer"; value: IntegerTypeDef }
    | { kind: "float"; value: FloatTypeDef }
    | { kind: "double"; value: DoubleTypeDef }
    | { kind: "date"; value: DateTypeDef }
    | { kind: "timestamp"; value: TimestampTypeDef }
    | { kind: "geopoint"; value: GeopointTypeDef };

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

export type TypeDef =
    | PrimitiveTypeDef
    | { kind: "list"; value: ListTypeDef }
    | { kind: "map"; value: MapTypeDef }
    | { kind: "struct"; value: StructTypeDef }
    | { kind: "union"; value: UnionTypeDef }
    | { kind: "optional"; value: OptionalTypeDef }
    | { kind: "result"; value: ResultTypeDef }
    | { kind: "ref"; value: TypeRef };

export interface NamedTypeDef {
    name: string;
    description?: string;
    type: TypeDef;
}

export interface SchemaIR {
    types: NamedTypeDef[];
}
