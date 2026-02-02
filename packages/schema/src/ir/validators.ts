// Auto-generated file - do not edit manually

import { z } from "zod/mini";
import * as t from "./types.js";

export const Deprecation: z.ZodMiniType<t.Deprecation> = z.object({ message: z.string() });

export const StringEnumConstraint: z.ZodMiniType<t.StringEnumConstraint> = z.object({
    options: z.array(z.object({ value: z.string(), label: z.optional(z.string()) })),
});

export const StringRegexConstraint: z.ZodMiniType<t.StringRegexConstraint> = z.object({ regex: z.string() });

export const StringConstraint: z.ZodMiniType<t.StringConstraint> = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("enum"), value: z.lazy(() => StringEnumConstraint) }),
    z.object({ kind: z.literal("regex"), value: z.lazy(() => StringRegexConstraint) }),
]);

export const StringTypeDef: z.ZodMiniType<t.StringTypeDef> = z.object({
    constraint: z.optional(z.lazy(() => StringConstraint)),
});

export const BooleanTypeDef: z.ZodMiniType<t.BooleanTypeDef> = z.object({});

export const IntegerTypeDef: z.ZodMiniType<t.IntegerTypeDef> = z.object({});

export const FloatTypeDef: z.ZodMiniType<t.FloatTypeDef> = z.object({});

export const DoubleTypeDef: z.ZodMiniType<t.DoubleTypeDef> = z.object({});

export const DateTypeDef: z.ZodMiniType<t.DateTypeDef> = z.object({});

export const TimestampTypeDef: z.ZodMiniType<t.TimestampTypeDef> = z.object({});

export const GeopointTypeDef: z.ZodMiniType<t.GeopointTypeDef> = z.object({});

export const ListTypeDef: z.ZodMiniType<t.ListTypeDef> = z.object({ elementType: z.lazy(() => TypeDef) });

export const MapTypeDef: z.ZodMiniType<t.MapTypeDef> = z.object({
    keyType: z.lazy(() => TypeDef),
    valueType: z.lazy(() => TypeDef),
});

export const FieldDef: z.ZodMiniType<t.FieldDef> = z.object({
    id: z.optional(z.string()),
    name: z.string(),
    displayName: z.string(),
    type: z.lazy(() => TypeDef),
    description: z.optional(z.string()),
    deprecated: z.optional(z.lazy(() => Deprecation)),
});

export const StructTypeDef: z.ZodMiniType<t.StructTypeDef> = z.object({
    fields: z.array(z.lazy(() => FieldDef)),
});

export const VariantDef: z.ZodMiniType<t.VariantDef> = z.object({
    name: z.string(),
    type: z.lazy(() => TypeDef),
});

export const UnionTypeDef: z.ZodMiniType<t.UnionTypeDef> = z.object({
    variants: z.array(z.lazy(() => VariantDef)),
});

export const OptionalTypeDef: z.ZodMiniType<t.OptionalTypeDef> = z.object({ type: z.lazy(() => TypeDef) });

export const ResultTypeDef: z.ZodMiniType<t.ResultTypeDef> = z.object({
    okType: z.lazy(() => TypeDef),
    errType: z.lazy(() => TypeDef),
});

export const TypeRef: z.ZodMiniType<t.TypeRef> = z.object({ name: z.string() });

export const TypeDef: z.ZodMiniType<t.TypeDef> = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("string"), value: z.lazy(() => StringTypeDef) }),
    z.object({ kind: z.literal("boolean"), value: z.lazy(() => BooleanTypeDef) }),
    z.object({ kind: z.literal("integer"), value: z.lazy(() => IntegerTypeDef) }),
    z.object({ kind: z.literal("float"), value: z.lazy(() => FloatTypeDef) }),
    z.object({ kind: z.literal("double"), value: z.lazy(() => DoubleTypeDef) }),
    z.object({ kind: z.literal("date"), value: z.lazy(() => DateTypeDef) }),
    z.object({ kind: z.literal("timestamp"), value: z.lazy(() => TimestampTypeDef) }),
    z.object({ kind: z.literal("geopoint"), value: z.lazy(() => GeopointTypeDef) }),
    z.object({ kind: z.literal("list"), value: z.lazy(() => ListTypeDef) }),
    z.object({ kind: z.literal("map"), value: z.lazy(() => MapTypeDef) }),
    z.object({ kind: z.literal("struct"), value: z.lazy(() => StructTypeDef) }),
    z.object({ kind: z.literal("union"), value: z.lazy(() => UnionTypeDef) }),
    z.object({ kind: z.literal("optional"), value: z.lazy(() => OptionalTypeDef) }),
    z.object({ kind: z.literal("result"), value: z.lazy(() => ResultTypeDef) }),
    z.object({ kind: z.literal("ref"), value: z.lazy(() => TypeRef) }),
]);

export const NamedTypeDef: z.ZodMiniType<t.NamedTypeDef> = z.object({
    name: z.string(),
    description: z.optional(z.string()),
    deprecated: z.optional(z.lazy(() => Deprecation)),
    type: z.lazy(() => TypeDef),
});

export const SchemaIR: z.ZodMiniType<t.SchemaIR> = z.object({ types: z.array(z.lazy(() => NamedTypeDef)) });
