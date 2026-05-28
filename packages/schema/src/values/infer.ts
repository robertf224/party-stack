import type { date, double, float, geopoint, integer, Result, timestamp } from "./values.js";
import type { SchemaIR, TypeDef } from "../ir/generated/types.js";

type ReadonlyDeep<T> = T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer Element)[]
      ? readonly ReadonlyDeep<Element>[]
      : T extends object
        ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> }
        : T;

type MutableDeep<T> = T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer Element)[]
      ? Array<MutableDeep<Element>>
      : T extends object
        ? { -readonly [K in keyof T]: MutableDeep<T[K]> }
        : T;

type ArrayElement<T> = T extends (infer Element)[] ? Element : never;

type FlattenObject<T> = { [K in keyof T]: T[K] } & {};

type SchemaTypeDefs<Schema> = Schema extends { types: infer Types } ? ArrayElement<Types> : never;

type SchemaTypeName<Schema> =
    SchemaTypeDefs<Schema> extends {
        name: infer Name extends string;
    }
        ? Name
        : never;

type TypeKind<Type> = Type extends { kind: infer Kind extends string } ? Kind : never;

type TypeValue<Type> = Type extends { value: infer Value } ? Value : never;

type InferString<Value> = Value extends { constraint: infer Constraint }
    ? Constraint extends { kind: "enum"; value: { options: infer Options } }
        ? ArrayElement<Options> extends { value: infer OptionValue extends string }
            ? OptionValue
            : never
        : string
    : string;

type StructField<Fields> = ArrayElement<Fields>;

type FieldName<Field> = Field extends { name: infer Name extends PropertyKey } ? Name : never;

type FieldByName<Fields, Name extends PropertyKey> = Extract<StructField<Fields>, { name: Name }>;

type FieldType<Fields, Name extends PropertyKey> =
    FieldByName<Fields, Name> extends { type: infer Type } ? Type : never;

type RequiredFieldNames<Fields> =
    StructField<Fields> extends infer Field
        ? Field extends { type: infer Type }
            ? TypeKind<Type> extends "optional"
                ? never
                : FieldName<Field>
            : never
        : never;

type OptionalFieldNames<Fields> =
    StructField<Fields> extends infer Field
        ? Field extends { type: infer Type }
            ? TypeKind<Type> extends "optional"
                ? FieldName<Field>
                : never
            : never
        : never;

type InferStructFields<Fields, Schema> =
    StructField<Fields> extends never
        ? Record<never, never>
        : FlattenObject<
              {
                  [Name in RequiredFieldNames<Fields>]: InferNode<FieldType<Fields, Name>, Schema>;
              } & {
                  [Name in OptionalFieldNames<Fields>]?: InferNode<
                      TypeValue<FieldType<Fields, Name>> extends { type: infer Inner } ? Inner : never,
                      Schema
                  >;
              }
          >;

type InferUnionVariant<Variant, Schema> = Variant extends {
    name: infer Name extends string;
    type: infer Type;
}
    ? { kind: Name; value: InferNode<Type, Schema> }
    : never;

type InferByKind<Type, Schema> = {
    string: InferString<TypeValue<Type>>;
    boolean: boolean;
    integer: integer;
    float: float;
    double: double;
    date: date;
    timestamp: timestamp;
    geopoint: geopoint;
    unknown: unknown;
    list: TypeValue<Type> extends { elementType: infer ElementType }
        ? Array<InferNode<ElementType, Schema>>
        : never;
    map: TypeValue<Type> extends { valueType: infer ValueType }
        ? Record<string, InferNode<ValueType, Schema>>
        : never;
    struct: TypeValue<Type> extends { fields: infer Fields } ? InferStructFields<Fields, Schema> : never;
    union: TypeValue<Type> extends { variants: infer Variants }
        ? InferUnionVariant<ArrayElement<Variants>, Schema>
        : never;
    optional: TypeValue<Type> extends { type: infer Inner } ? InferNode<Inner, Schema> | undefined : never;
    result: TypeValue<Type> extends { okType: infer OkType; errType: infer ErrType }
        ? Result<InferNode<OkType, Schema>, InferNode<ErrType, Schema>>
        : never;
    ref: TypeValue<Type> extends { name: infer Name extends string } ? InferSchemaType<Schema, Name> : never;
};

type InferTypeDef<Type, Schema> =
    TypeKind<Type> extends keyof InferByKind<Type, Schema>
        ? InferByKind<Type, Schema>[TypeKind<Type>]
        : never;

type InferSchemaType<Schema, Name extends string> =
    Extract<SchemaTypeDefs<Schema>, { name: Name }> extends {
        type: infer Type;
    }
        ? InferTypeDef<Type, Schema>
        : never;

type InferSchema<Schema> = {
    [Name in SchemaTypeName<Schema>]: InferSchemaType<Schema, Name>;
};

type InferNode<Input, Schema> = Input extends SchemaIR ? InferSchema<Input> : InferTypeDef<Input, Schema>;

export type ConstSchemaIR = ReadonlyDeep<SchemaIR>;
export type ConstTypeDef = ReadonlyDeep<TypeDef>;

export type Infer<
    Input extends ConstSchemaIR | ConstTypeDef,
    Schema extends ConstSchemaIR = Extract<Input, ConstSchemaIR>,
> = InferNode<MutableDeep<Input>, MutableDeep<Schema>>;

export function defineSchema<const Schema>(schema: Schema): Schema {
    return schema;
}
