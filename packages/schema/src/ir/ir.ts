// TODO: default values

export interface StringEnumConstraint {
    kind: "enum";
    options: Array<{
        value: string;
        label?: string;
    }>;
}

export type StringConstraint = StringEnumConstraint;

export interface StringTypeDef {
    kind: "string";
    constraint?: StringConstraint;
}

export interface BooleanTypeDef {
    kind: "boolean";
}

export interface IntegerTypeDef {
    kind: "integer";
}

export interface FloatTypeDef {
    kind: "float";
}

export interface DoubleTypeDef {
    kind: "double";
}

export interface DateTypeDef {
    kind: "date";
}

export interface TimestampTypeDef {
    kind: "timestamp";
}

export interface GeopointTypeDef {
    kind: "geopoint";
}

export type PrimitiveTypeDef =
    | StringTypeDef
    | BooleanTypeDef
    | IntegerTypeDef
    | FloatTypeDef
    | DoubleTypeDef
    | DateTypeDef
    | TimestampTypeDef
    | GeopointTypeDef;

export interface ListTypeDef {
    kind: "list";
    elementType: TypeDef;
}

export interface MapTypeDef {
    kind: "map";
    keyType: TypeDef;
    valueType: TypeDef;
}

export interface FieldDef {
    id?: string;
    apiName: string;
    type: TypeDef;
    displayName: string;
    description?: string;
}

export interface StructTypeDef {
    kind: "struct";
    fields: FieldDef[];
}

export interface VariantDef {
    apiName: string;
    type: TypeDef;
}

export interface UnionTypeDef {
    kind: "union";
    variants: VariantDef[];
}

export interface ResultTypeDef {
    kind: "result";
    okType: TypeDef;
    errType: TypeDef;
}

export interface TypeRef {
    kind: "ref";
    apiName: string;
}

export type TypeDef = (
    | PrimitiveTypeDef
    | ListTypeDef
    | MapTypeDef
    | StructTypeDef
    | UnionTypeDef
    | ResultTypeDef
    | TypeRef
) & {
    required?: boolean;
};

export interface NamedTypeDef {
    apiName: string;
    description?: string;
    type: TypeDef;
}

export interface SchemaIR {
    types: NamedTypeDef[];
}
