import type { date, double, float, geopoint, integer, Result, timestamp } from "./values.js";
import type { SchemaIR } from "../ir/generated/types.js";

type ReadonlyDeep<T> = T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer Element)[]
      ? readonly ReadonlyDeep<Element>[]
      : T extends object
        ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> }
        : T;

export type ConstSchemaIR = ReadonlyDeep<SchemaIR>;

export function defineSchema<const Schema>(schema: Schema): Schema {
    return schema;
}

type ArrayElement<T> = T extends readonly (infer Element)[] ? Element : never;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (
    value: infer Intersection
) => void
    ? Intersection
    : never;

type SchemaTypeDefs<Schema> = Schema extends { readonly types: infer Types } ? ArrayElement<Types> : never;

type SchemaTypeName<Schema> =
    SchemaTypeDefs<Schema> extends {
        readonly name: infer Name extends string;
    }
        ? Name
        : never;

type TypeKind<Type> = Type extends { readonly kind: infer Kind extends string } ? Kind : never;

type TypeValue<Type> = Type extends { readonly value: infer Value } ? Value : never;

type InferString<Value> =
    Value extends {
        readonly constraint: {
            readonly kind: "enum";
            readonly value: { readonly options: infer Options };
        };
    }
        ? ArrayElement<Options> extends { readonly value: infer OptionValue extends string }
            ? OptionValue
            : never
        : string;

type OptionalInner<Type> = TypeValue<Type> extends { readonly type: infer Inner } ? Inner : never;

type InferRequiredStructField<Field, Schema> = Field extends {
    readonly name: infer Name extends PropertyKey;
    readonly type: infer Type;
}
    ? TypeKind<Type> extends "optional"
        ? never
        : { [K in Name]: Infer<Type, Schema> }
    : never;

type InferOptionalStructField<Field, Schema> = Field extends {
    readonly name: infer Name extends PropertyKey;
    readonly type: infer Type;
}
    ? TypeKind<Type> extends "optional"
        ? { [K in Name]?: Infer<OptionalInner<Type>, Schema> }
        : never
    : never;

type InferStructFields<Fields, Schema> =
    ArrayElement<Fields> extends never
        ? Record<never, never>
        : Simplify<
              UnionToIntersection<InferRequiredStructField<ArrayElement<Fields>, Schema>> &
                  UnionToIntersection<InferOptionalStructField<ArrayElement<Fields>, Schema>>
          >;

type InferUnionVariant<Variant, Schema> = Variant extends {
    readonly name: infer Name extends string;
    readonly type: infer Type;
}
    ? { kind: Name; value: Infer<Type, Schema> }
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
    list: TypeValue<Type> extends { readonly elementType: infer ElementType }
        ? Array<Infer<ElementType, Schema>>
        : never;
    map: TypeValue<Type> extends { readonly valueType: infer ValueType }
        ? Record<string, Infer<ValueType, Schema>>
        : never;
    struct: TypeValue<Type> extends { readonly fields: infer Fields } ? InferStructFields<Fields, Schema> : never;
    union: TypeValue<Type> extends { readonly variants: infer Variants }
        ? InferUnionVariant<ArrayElement<Variants>, Schema>
        : never;
    optional: Infer<OptionalInner<Type>, Schema> | undefined;
    result: TypeValue<Type> extends {
        readonly okType: infer OkType;
        readonly errType: infer ErrType;
    }
        ? Result<Infer<OkType, Schema>, Infer<ErrType, Schema>>
        : never;
    ref: TypeValue<Type> extends { readonly name: infer Name extends string } ? InferSchemaType<Schema, Name> : never;
};

type InferTypeDef<Type, Schema> =
    TypeKind<Type> extends keyof InferByKind<Type, Schema> ? InferByKind<Type, Schema>[TypeKind<Type>] : never;

type InferSchemaType<Schema, Name extends string> =
    Extract<SchemaTypeDefs<Schema>, { readonly name: Name }> extends {
        readonly type: infer Type;
    }
        ? InferTypeDef<Type, Schema>
        : never;

type InferSchema<Schema> = {
    [Name in SchemaTypeName<Schema>]: InferSchemaType<Schema, Name>;
};

export type Infer<Input, Schema = Input> =
    Input extends { readonly types: readonly unknown[] } ? InferSchema<Input> : InferTypeDef<Input, Schema>;
