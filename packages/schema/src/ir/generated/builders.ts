// Auto-generated file - do not edit manually

import { type StringConstraint, type TypeDef } from "./schema.js";

export const string = (value: Extract<TypeDef, { kind: "string" }>["value"]) => ({ kind: "string" as const, value });
export const boolean = (value: Extract<TypeDef, { kind: "boolean" }>["value"]) => ({ kind: "boolean" as const, value });
export const integer = (value: Extract<TypeDef, { kind: "integer" }>["value"]) => ({ kind: "integer" as const, value });
export const float = (value: Extract<TypeDef, { kind: "float" }>["value"]) => ({ kind: "float" as const, value });
export const double = (value: Extract<TypeDef, { kind: "double" }>["value"]) => ({ kind: "double" as const, value });
export const date = (value: Extract<TypeDef, { kind: "date" }>["value"]) => ({ kind: "date" as const, value });
export const timestamp = (value: Extract<TypeDef, { kind: "timestamp" }>["value"]) => ({ kind: "timestamp" as const, value });
export const geopoint = (value: Extract<TypeDef, { kind: "geopoint" }>["value"]) => ({ kind: "geopoint" as const, value });
export const list = (value: Extract<TypeDef, { kind: "list" }>["value"]) => ({ kind: "list" as const, value });
export const map = (value: Extract<TypeDef, { kind: "map" }>["value"]) => ({ kind: "map" as const, value });
export const struct = (value: Extract<TypeDef, { kind: "struct" }>["value"]) => ({ kind: "struct" as const, value });
export const union = (value: Extract<TypeDef, { kind: "union" }>["value"]) => ({ kind: "union" as const, value });
export const optional = (value: Extract<TypeDef, { kind: "optional" }>["value"]) => ({ kind: "optional" as const, value });
export const result = (value: Extract<TypeDef, { kind: "result" }>["value"]) => ({ kind: "result" as const, value });
export const ref = (value: Extract<TypeDef, { kind: "ref" }>["value"]) => ({ kind: "ref" as const, value });
export const StringConstraint = { enum: (value: Extract<StringConstraint, { kind: "enum" }>["value"]) => ({ kind: "enum" as const, value }) };
export const ir = { string, boolean, integer, float, double, date, timestamp, geopoint, list, map, struct, union, optional, result, ref, StringConstraint };