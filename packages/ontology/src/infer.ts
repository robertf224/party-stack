import type { NamedTypeDef, OntologyIR, TypeDef } from "./ir/generated/types.js";
import type { OntologyDefinition } from "./live/LiveOntology.js";
import type {
    attachment,
    date,
    double,
    float,
    geopoint,
    integer,
    Result,
    timestamp,
} from "./utils/values.js";

export type ReadonlyDeep<T> = T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer Element)[]
      ? readonly ReadonlyDeep<Element>[]
      : T extends object
        ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> }
        : T;

export type MutableDeep<T> = T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer Element)[]
      ? Array<MutableDeep<Element>>
      : T extends object
        ? { -readonly [K in keyof T]: MutableDeep<T[K]> }
        : T;

type ArrayElement<T> = T extends readonly (infer Element)[] ? Element : never;

type FlattenObject<T> = { [K in keyof T]: T[K] } & {};

type TypeKind<Type> = Type extends { readonly kind: infer Kind extends string } ? Kind : never;

type TypeValue<Type> = Type extends { readonly value: infer Value } ? Value : never;

type NamedTypes<Ontology> = Ontology extends { readonly types: infer Types } ? ArrayElement<Types> : never;

type ObjectTypes<Ontology> = Ontology extends { readonly objectTypes: infer ObjectTypes }
    ? ArrayElement<ObjectTypes>
    : never;

type ActionTypes<Ontology> = Ontology extends { readonly actionTypes: infer ActionTypes }
    ? ArrayElement<ActionTypes>
    : never;

type QueryFunctionTypes<Ontology> = Ontology extends { readonly queryFunctionTypes: infer QueryFunctionTypes }
    ? ArrayElement<QueryFunctionTypes>
    : never;

type ObjectTypeName<Ontology> =
    ObjectTypes<Ontology> extends { readonly name: infer Name extends PropertyKey } ? Name : never;

type ActionTypeName<Ontology> =
    ActionTypes<Ontology> extends { readonly name: infer Name extends PropertyKey } ? Name : never;

type QueryFunctionTypeName<Ontology> =
    QueryFunctionTypes<Ontology> extends { readonly name: infer Name extends PropertyKey } ? Name : never;

type NamedTypeByName<Ontology, Name extends PropertyKey> = Extract<
    NamedTypes<Ontology>,
    { readonly name: Name }
>;

type ObjectTypeByName<Ontology, Name extends PropertyKey> = Extract<
    ObjectTypes<Ontology>,
    { readonly name: Name }
>;

type ActionTypeByName<Ontology, Name extends PropertyKey> = Extract<
    ActionTypes<Ontology>,
    { readonly name: Name }
>;

type QueryFunctionTypeByName<Ontology, Name extends PropertyKey> = Extract<
    QueryFunctionTypes<Ontology>,
    { readonly name: Name }
>;

type ObjectTypeProperties<ObjectType> = ObjectType extends { readonly properties: infer Properties }
    ? Properties
    : never;

type InferString<Value> = Value extends { readonly constraint?: infer Constraint }
    ? NonNullable<Constraint> extends {
          readonly kind: "enum";
          readonly value: { readonly options: infer Options };
      }
        ? ArrayElement<Options> extends { readonly value: infer OptionValue extends string }
            ? OptionValue
            : never
        : string
    : string;

type StructField<Fields> = ArrayElement<Fields>;

type FieldName<Field> = Field extends { readonly name: infer Name extends PropertyKey } ? Name : never;

type FieldByName<Fields, Name extends PropertyKey> = Extract<
    StructField<Fields>,
    { readonly name: Name }
>;

type FieldType<Fields, Name extends PropertyKey> =
    FieldByName<Fields, Name> extends { readonly type: infer Type } ? Type : never;

type RequiredFieldNames<Fields> =
    StructField<Fields> extends infer Field
        ? Field extends { readonly type: infer Type }
            ? Type extends { readonly kind: "optional" }
                ? never
                : FieldName<Field>
            : never
        : never;

type OptionalFieldNames<Fields> =
    StructField<Fields> extends infer Field
        ? Field extends { readonly type: infer Type }
            ? Type extends { readonly kind: "optional" }
                ? FieldName<Field>
                : never
            : never
        : never;

type InferStructFields<Fields, Ontology> =
    StructField<Fields> extends never
        ? Record<never, never>
        : FlattenObject<
              {
                  [Name in RequiredFieldNames<Fields>]: InferType<FieldType<Fields, Name>, Ontology>;
              } & {
                  [Name in OptionalFieldNames<Fields>]?: TypeValue<FieldType<Fields, Name>> extends {
                      readonly type: infer Inner;
                  }
                      ? InferType<Inner, Ontology>
                      : never;
              }
          >;

type InferUnionVariant<Variant, Ontology> = Variant extends {
    readonly name: infer Name extends string;
    readonly type: infer Type;
}
    ? { kind: Name; value: InferType<Type, Ontology> }
    : never;

type ObjectPrimaryKey<ObjectType> = ObjectType extends {
    readonly primaryKey: infer PrimaryKey extends PropertyKey;
}
    ? PrimaryKey
    : never;

type InferObjectReference<Value, Ontology> = Value extends {
    readonly objectType: infer Name extends PropertyKey;
}
    ? InferType<FieldType<ObjectTypeProperties<ObjectTypeByName<Ontology, Name>>, ObjectPrimaryKey<ObjectTypeByName<Ontology, Name>>>, Ontology>
    : never;

type InferByKind<Type, Ontology> = {
    string: InferString<TypeValue<Type>>;
    boolean: boolean;
    integer: integer;
    float: float;
    double: double;
    date: date;
    timestamp: timestamp;
    geopoint: geopoint;
    attachment: attachment;
    objectReference: InferObjectReference<TypeValue<Type>, Ontology>;
    unknown: unknown;
    list: TypeValue<Type> extends { readonly elementType: infer ElementType }
        ? Array<InferType<ElementType, Ontology>>
        : never;
    map: TypeValue<Type> extends { readonly valueType: infer ValueType }
        ? Record<string, InferType<ValueType, Ontology>>
        : never;
    struct: TypeValue<Type> extends { readonly fields: infer Fields } ? InferStructFields<Fields, Ontology> : never;
    union: TypeValue<Type> extends { readonly variants: infer Variants }
        ? InferUnionVariant<ArrayElement<Variants>, Ontology>
        : never;
    optional: TypeValue<Type> extends { readonly type: infer Inner }
        ? InferType<Inner, Ontology> | undefined
        : never;
    result: TypeValue<Type> extends { readonly okType: infer OkType; readonly errType: infer ErrType }
        ? Result<InferType<OkType, Ontology>, InferType<ErrType, Ontology>>
        : never;
    ref: TypeValue<Type> extends { readonly name: infer Name extends PropertyKey }
        ? InferNamedTypeByName<Ontology, Name>
        : never;
};

export type InferType<Type, Ontology = never> =
    TypeKind<Type> extends keyof InferByKind<Type, Ontology>
        ? InferByKind<Type, Ontology>[TypeKind<Type>]
        : never;

type InferNamedTypeByName<Ontology, Name extends PropertyKey> =
    NamedTypeByName<Ontology, Name> extends { readonly type: infer Type }
        ? InferType<Type, Ontology>
        : ObjectTypeByName<Ontology, Name> extends { readonly properties: infer Properties }
          ? InferStructFields<Properties, Ontology>
          : never;

export type InferNamedType<Type, Ontology = never> = Type extends { readonly type: infer TypeDef }
    ? InferType<TypeDef, Ontology>
    : never;

type InferObjectType<ObjectType, Ontology> = ObjectType extends { readonly properties: infer Properties }
    ? InferStructFields<Properties, Ontology>
    : never;

type ActionParameters<ActionType> = ActionType extends { readonly parameters: infer Parameters }
    ? Parameters
    : never;

type ActionParameter<Parameters> = ArrayElement<Parameters>;

type ActionParameterName<Parameter> = Parameter extends { readonly name: infer Name extends PropertyKey }
    ? Name
    : never;

type ActionParameterByName<Parameters, Name extends PropertyKey> = Extract<
    ActionParameter<Parameters>,
    { readonly name: Name }
>;

type ActionParameterType<Parameters, Name extends PropertyKey> =
    ActionParameterByName<Parameters, Name> extends { readonly type: infer Type } ? Type : never;

type RequiredActionParameterNames<Parameters> =
    ActionParameter<Parameters> extends infer Parameter
        ? Parameter extends { readonly type: infer Type }
            ? Type extends { readonly kind: "optional" }
                ? never
                : Parameter extends { readonly defaultValue: unknown }
                  ? never
                  : ActionParameterName<Parameter>
            : never
        : never;

type OptionalActionParameterNames<Parameters> =
    ActionParameter<Parameters> extends infer Parameter
        ? Parameter extends { readonly type: infer Type }
            ? Type extends { readonly kind: "optional" }
                ? ActionParameterName<Parameter>
                : Parameter extends { readonly defaultValue: unknown }
                  ? ActionParameterName<Parameter>
                  : never
            : never
        : never;

type InferActionParameter<Parameters, Name extends PropertyKey, Ontology> =
    ActionParameterType<Parameters, Name> extends infer Type
        ? Type extends { readonly kind: "optional"; readonly value: { readonly type: infer Inner } }
            ? InferType<Inner, Ontology> | null
            : InferType<Type, Ontology>
        : never;

type InferActionParameters<Parameters, Ontology> =
    ActionParameter<Parameters> extends never
        ? Record<never, never>
        : FlattenObject<
              {
                  [Name in RequiredActionParameterNames<Parameters>]: InferActionParameter<
                      Parameters,
                      Name,
                      Ontology
                  >;
              } & {
                  [Name in OptionalActionParameterNames<Parameters>]?: InferActionParameter<
                      Parameters,
                      Name,
                      Ontology
                  >;
              }
          >;

type QueryParameters<QueryFunctionType> = QueryFunctionType extends { readonly parameters: infer Parameters }
    ? Parameters
    : never;

type QueryReturnType<QueryFunctionType> = QueryFunctionType extends { readonly returnType: infer ReturnType }
    ? ReturnType
    : never;

type QueryParameter<Parameters> = ArrayElement<Parameters>;

type QueryParameterName<Parameter> = Parameter extends { readonly name: infer Name extends PropertyKey }
    ? Name
    : never;

type QueryParameterByName<Parameters, Name extends PropertyKey> = Extract<
    QueryParameter<Parameters>,
    { readonly name: Name }
>;

type QueryParameterType<Parameters, Name extends PropertyKey> =
    QueryParameterByName<Parameters, Name> extends { readonly type: infer Type } ? Type : never;

type RequiredQueryParameterNames<Parameters> =
    QueryParameter<Parameters> extends infer Parameter
        ? Parameter extends { readonly type: infer Type }
            ? Type extends { readonly kind: "optional" }
                ? never
                : QueryParameterName<Parameter>
            : never
        : never;

type OptionalQueryParameterNames<Parameters> =
    QueryParameter<Parameters> extends infer Parameter
        ? Parameter extends { readonly type: infer Type }
            ? Type extends { readonly kind: "optional" }
                ? QueryParameterName<Parameter>
                : never
            : never
        : never;

type InferQueryParameter<Parameters, Name extends PropertyKey, Ontology> =
    QueryParameterType<Parameters, Name> extends infer Type
        ? Type extends { readonly kind: "optional"; readonly value: { readonly type: infer Inner } }
            ? InferType<Inner, Ontology>
            : InferType<Type, Ontology>
        : never;

type InferQueryParameters<Parameters, Ontology> =
    QueryParameter<Parameters> extends never
        ? Record<never, never>
        : FlattenObject<
              {
                  [Name in RequiredQueryParameterNames<Parameters>]: InferQueryParameter<
                      Parameters,
                      Name,
                      Ontology
                  >;
              } & {
                  [Name in OptionalQueryParameterNames<Parameters>]?: InferQueryParameter<
                      Parameters,
                      Name,
                      Ontology
                  >;
              }
          >;

export type InferOntology<Ontology> = {
    objectTypes: {
        [Name in ObjectTypeName<Ontology>]: InferObjectType<ObjectTypeByName<Ontology, Name>, Ontology>;
    };
    actionTypes: {
        [Name in ActionTypeName<Ontology>]: {
            parameters: InferActionParameters<ActionParameters<ActionTypeByName<Ontology, Name>>, Ontology>;
        };
    };
    queryFunctionTypes: {
        [Name in QueryFunctionTypeName<Ontology>]: {
            parameters: InferQueryParameters<QueryParameters<QueryFunctionTypeByName<Ontology, Name>>, Ontology>;
            returnType: InferType<QueryReturnType<QueryFunctionTypeByName<Ontology, Name>>, Ontology>;
        };
    };
} & OntologyDefinition;

export type ConstOntologyIR = ReadonlyDeep<OntologyIR>;
export type ConstTypeDef = ReadonlyDeep<TypeDef>;
export type ConstNamedTypeDef = ReadonlyDeep<NamedTypeDef>;

export type Infer<
    Input extends ConstOntologyIR | ConstNamedTypeDef | ConstTypeDef,
    Ontology extends ConstOntologyIR = Extract<Input, ConstOntologyIR>,
> = Input extends ConstOntologyIR
    ? InferOntology<Input>
    : Input extends ConstNamedTypeDef
      ? InferNamedType<Input, Ontology>
      : Input extends ConstTypeDef
        ? InferType<Input, Ontology>
        : never;

export function defineOntology<const Ontology extends ConstOntologyIR>(
    ontology: Ontology
): MutableDeep<Ontology> {
    return ontology as MutableDeep<Ontology>;
}

export function defineType<const Type extends ConstTypeDef>(type: Type): MutableDeep<Type> {
    return type as MutableDeep<Type>;
}

export function defineNamedType<const Type extends ConstNamedTypeDef>(type: Type): MutableDeep<Type> {
    return type as MutableDeep<Type>;
}
