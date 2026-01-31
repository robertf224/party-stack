// Auto-generated file - do not edit manually

import { z } from "zod/mini";

/** Constrains a string to a set of allowed values. */
export const StringEnumConstraint = z.object({
    get options() {
        return z.array(
            z.object({
                get value() {
                    return z.string();
                },
                get label() {
                    return z.optional(z.string());
                },
            })
        );
    },
});

export type StringEnumConstraint = z.infer<typeof StringEnumConstraint>;

/** A constraint that can be applied to a string type. */
export const StringConstraint = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("enum"), value: StringEnumConstraint }),
]);

export type StringConstraint = z.infer<typeof StringConstraint>;

/** A string type with optional constraints. */
export const StringTypeDef = z.object({
    get constraint() {
        return z.optional(StringConstraint);
    },
});

export type StringTypeDef = z.infer<typeof StringTypeDef>;

/** A boolean type. */
export const BooleanTypeDef = z.object({});

export type BooleanTypeDef = z.infer<typeof BooleanTypeDef>;

/** A 32-bit integer type. */
export const IntegerTypeDef = z.object({});

export type IntegerTypeDef = z.infer<typeof IntegerTypeDef>;

/** A 32-bit floating point type. */
export const FloatTypeDef = z.object({});

export type FloatTypeDef = z.infer<typeof FloatTypeDef>;

/** A 64-bit floating point type. */
export const DoubleTypeDef = z.object({});

export type DoubleTypeDef = z.infer<typeof DoubleTypeDef>;

/** A date type (no time component). */
export const DateTypeDef = z.object({});

export type DateTypeDef = z.infer<typeof DateTypeDef>;

/** A timestamp type (instant in time). */
export const TimestampTypeDef = z.object({});

export type TimestampTypeDef = z.infer<typeof TimestampTypeDef>;

/** A geographic point (lat/lon). */
export const GeopointTypeDef = z.object({});

export type GeopointTypeDef = z.infer<typeof GeopointTypeDef>;

/** A list/array type. */
export const ListTypeDef = z.object({
    get elementType() {
        return TypeDef;
    },
});

export type ListTypeDef = z.infer<typeof ListTypeDef>;

/** A map/record type. */
export const MapTypeDef = z.object({
    get keyType() {
        return TypeDef;
    },
    get valueType() {
        return TypeDef;
    },
});

export type MapTypeDef = z.infer<typeof MapTypeDef>;

/** Definition of a field in a struct. */
export const FieldDef = z.object({
    get id() {
        return z.optional(z.string());
    },
    get name() {
        return z.string();
    },
    get displayName() {
        return z.string();
    },
    get type() {
        return TypeDef;
    },
    get description() {
        return z.optional(z.string());
    },
});

export type FieldDef = z.infer<typeof FieldDef>;

/** A struct type with named fields. */
export const StructTypeDef = z.object({
    get fields() {
        return z.array(FieldDef);
    },
});

export type StructTypeDef = z.infer<typeof StructTypeDef>;

/** Definition of a variant in a discriminated union. */
export const VariantDef = z.object({
    get name() {
        return z.string();
    },
    get type() {
        return TypeDef;
    },
});

export type VariantDef = z.infer<typeof VariantDef>;

/** A discriminated union type. */
export const UnionTypeDef = z.object({
    get variants() {
        return z.array(VariantDef);
    },
});

export type UnionTypeDef = z.infer<typeof UnionTypeDef>;

/** Wraps a type to make it optional. */
export const OptionalTypeDef = z.object({
    get type() {
        return TypeDef;
    },
});

export type OptionalTypeDef = z.infer<typeof OptionalTypeDef>;

/** A result type (ok or error). */
export const ResultTypeDef = z.object({
    get okType() {
        return TypeDef;
    },
    get errType() {
        return TypeDef;
    },
});

export type ResultTypeDef = z.infer<typeof ResultTypeDef>;

/** A reference to a named type. */
export const TypeRef = z.object({
    get name() {
        return z.string();
    },
});

export type TypeRef = z.infer<typeof TypeRef>;

/** A type definition. Can be a primitive, collection, struct, union, optional, result, or reference. */
export const TypeDef = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("string"), value: StringTypeDef }),
    z.object({ kind: z.literal("boolean"), value: BooleanTypeDef }),
    z.object({ kind: z.literal("integer"), value: IntegerTypeDef }),
    z.object({ kind: z.literal("float"), value: FloatTypeDef }),
    z.object({ kind: z.literal("double"), value: DoubleTypeDef }),
    z.object({ kind: z.literal("date"), value: DateTypeDef }),
    z.object({ kind: z.literal("timestamp"), value: TimestampTypeDef }),
    z.object({ kind: z.literal("geopoint"), value: GeopointTypeDef }),
    z.object({ kind: z.literal("list"), value: ListTypeDef }),
    z.object({ kind: z.literal("map"), value: MapTypeDef }),
    z.object({ kind: z.literal("struct"), value: StructTypeDef }),
    z.object({ kind: z.literal("union"), value: UnionTypeDef }),
    z.object({ kind: z.literal("optional"), value: OptionalTypeDef }),
    z.object({ kind: z.literal("result"), value: ResultTypeDef }),
    z.object({ kind: z.literal("ref"), value: TypeRef }),
]);

export type TypeDef = z.infer<typeof TypeDef>;

/** A named type definition that can be referenced by other types. */
export const NamedTypeDef = z.object({
    get name() {
        return z.string();
    },
    get description() {
        return z.optional(z.string());
    },
    get type() {
        return TypeDef;
    },
});

export type NamedTypeDef = z.infer<typeof NamedTypeDef>;

/** The root schema containing all type definitions. */
export const SchemaIR = z.object({
    get types() {
        return z.array(NamedTypeDef);
    },
});

export type SchemaIR = z.infer<typeof SchemaIR>;
