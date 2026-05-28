// Auto-generated file - do not edit manually

import * as t from "./types.js";

export const string = <const Value extends Extract<t.TypeDef, { kind: "string" }>["value"]>(
    value: Value
) => ({ kind: "string" as const, value });

export const boolean = <const Value extends Extract<t.TypeDef, { kind: "boolean" }>["value"]>(
    value: Value
) => ({ kind: "boolean" as const, value });

export const integer = <const Value extends Extract<t.TypeDef, { kind: "integer" }>["value"]>(
    value: Value
) => ({ kind: "integer" as const, value });

export const float = <const Value extends Extract<t.TypeDef, { kind: "float" }>["value"]>(value: Value) => ({
    kind: "float" as const,
    value,
});

export const double = <const Value extends Extract<t.TypeDef, { kind: "double" }>["value"]>(
    value: Value
) => ({ kind: "double" as const, value });

export const date = <const Value extends Extract<t.TypeDef, { kind: "date" }>["value"]>(value: Value) => ({
    kind: "date" as const,
    value,
});

export const timestamp = <const Value extends Extract<t.TypeDef, { kind: "timestamp" }>["value"]>(
    value: Value
) => ({ kind: "timestamp" as const, value });

export const geopoint = <const Value extends Extract<t.TypeDef, { kind: "geopoint" }>["value"]>(
    value: Value
) => ({ kind: "geopoint" as const, value });

export const list = <const Value extends Extract<t.TypeDef, { kind: "list" }>["value"]>(value: Value) => ({
    kind: "list" as const,
    value,
});

export const map = <const Value extends Extract<t.TypeDef, { kind: "map" }>["value"]>(value: Value) => ({
    kind: "map" as const,
    value,
});

export const struct = <const Value extends Extract<t.TypeDef, { kind: "struct" }>["value"]>(
    value: Value
) => ({ kind: "struct" as const, value });

export const union = <const Value extends Extract<t.TypeDef, { kind: "union" }>["value"]>(value: Value) => ({
    kind: "union" as const,
    value,
});

export const optional = <const Value extends Extract<t.TypeDef, { kind: "optional" }>["value"]>(
    value: Value
) => ({ kind: "optional" as const, value });

export const result = <const Value extends Extract<t.TypeDef, { kind: "result" }>["value"]>(
    value: Value
) => ({ kind: "result" as const, value });

export const ref = <const Value extends Extract<t.TypeDef, { kind: "ref" }>["value"]>(value: Value) => ({
    kind: "ref" as const,
    value,
});

export const unknown = <const Value extends Extract<t.TypeDef, { kind: "unknown" }>["value"]>(
    value: Value
) => ({ kind: "unknown" as const, value });

export const attachment = <const Value extends Extract<t.TypeDef, { kind: "attachment" }>["value"]>(
    value: Value
) => ({ kind: "attachment" as const, value });

export const objectReference = <const Value extends Extract<t.TypeDef, { kind: "objectReference" }>["value"]>(
    value: Value
) => ({ kind: "objectReference" as const, value });

export const StringConstraint = {
    enum: <const Value extends Extract<t.StringConstraint, { kind: "enum" }>["value"]>(value: Value) => ({
        kind: "enum" as const,
        value,
    }),
    regex: <const Value extends Extract<t.StringConstraint, { kind: "regex" }>["value"]>(value: Value) => ({
        kind: "regex" as const,
        value,
    }),
};

export const FunctionCallExpression = {
    uuid: <const Value extends Extract<t.FunctionCallExpression, { kind: "uuid" }>["value"]>(
        value: Value
    ) => ({ kind: "uuid" as const, value }),
    now: <const Value extends Extract<t.FunctionCallExpression, { kind: "now" }>["value"]>(value: Value) => ({
        kind: "now" as const,
        value,
    }),
};

export const Expression = {
    valueReference: <const Value extends Extract<t.Expression, { kind: "valueReference" }>["value"]>(
        value: Value
    ) => ({ kind: "valueReference" as const, value }),
    contextReference: <const Value extends Extract<t.Expression, { kind: "contextReference" }>["value"]>(
        value: Value
    ) => ({ kind: "contextReference" as const, value }),
    functionCall: <const Value extends Extract<t.Expression, { kind: "functionCall" }>["value"]>(
        value: Value
    ) => ({ kind: "functionCall" as const, value }),
    literal: <const Value extends Extract<t.Expression, { kind: "literal" }>["value"]>(value: Value) => ({
        kind: "literal" as const,
        value,
    }),
};

export const ActionLogicStep = {
    createObject: <const Value extends Extract<t.ActionLogicStep, { kind: "createObject" }>["value"]>(
        value: Value
    ) => ({ kind: "createObject" as const, value }),
    updateObject: <const Value extends Extract<t.ActionLogicStep, { kind: "updateObject" }>["value"]>(
        value: Value
    ) => ({ kind: "updateObject" as const, value }),
    deleteObject: <const Value extends Extract<t.ActionLogicStep, { kind: "deleteObject" }>["value"]>(
        value: Value
    ) => ({ kind: "deleteObject" as const, value }),
};

export const o = {
    string,
    boolean,
    integer,
    float,
    double,
    date,
    timestamp,
    geopoint,
    list,
    map,
    struct,
    union,
    optional,
    result,
    ref,
    unknown,
    attachment,
    objectReference,
    StringConstraint,
    FunctionCallExpression,
    Expression,
    ActionLogicStep,
};
