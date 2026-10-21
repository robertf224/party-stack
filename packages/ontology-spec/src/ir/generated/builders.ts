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

export const encrypted = <const Value extends Extract<t.TypeDef, { kind: "encrypted" }>["value"]>(
    value: Value
) => ({ kind: "encrypted" as const, value });

export const ref = <const Value extends Extract<t.TypeDef, { kind: "ref" }>["value"]>(value: Value) => ({
    kind: "ref" as const,
    value,
});

export const attachment = <const Value extends Extract<t.TypeDef, { kind: "attachment" }>["value"]>(
    value: Value
) => ({ kind: "attachment" as const, value });

export const objectReference = <const Value extends Extract<t.TypeDef, { kind: "objectReference" }>["value"]>(
    value: Value
) => ({ kind: "objectReference" as const, value });

export const unknown = <const Value extends Extract<t.TypeDef, { kind: "unknown" }>["value"]>(
    value: Value
) => ({ kind: "unknown" as const, value });

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

export const AttachmentContentConstraint = {
    image: <const Value extends Extract<t.AttachmentContentConstraint, { kind: "image" }>["value"]>(
        value: Value
    ) => ({ kind: "image" as const, value }),
};

export const Expression = {
    inputReference: <const Value extends Extract<t.Expression, { kind: "inputReference" }>["value"]>(
        value: Value
    ) => ({ kind: "inputReference" as const, value }),
    contextReference: <const Value extends Extract<t.Expression, { kind: "contextReference" }>["value"]>(
        value: Value
    ) => ({ kind: "contextReference" as const, value }),
    localReference: <const Value extends Extract<t.Expression, { kind: "localReference" }>["value"]>(
        value: Value
    ) => ({ kind: "localReference" as const, value }),
    getAt: <const Value extends Extract<t.Expression, { kind: "getAt" }>["value"]>(value: Value) => ({
        kind: "getAt" as const,
        value,
    }),
    objectLookup: <const Value extends Extract<t.Expression, { kind: "objectLookup" }>["value"]>(
        value: Value
    ) => ({ kind: "objectLookup" as const, value }),
    linkHop: <const Value extends Extract<t.Expression, { kind: "linkHop" }>["value"]>(value: Value) => ({
        kind: "linkHop" as const,
        value,
    }),
    struct: <const Value extends Extract<t.Expression, { kind: "struct" }>["value"]>(value: Value) => ({
        kind: "struct" as const,
        value,
    }),
    map: <const Value extends Extract<t.Expression, { kind: "map" }>["value"]>(value: Value) => ({
        kind: "map" as const,
        value,
    }),
    uuid: <const Value extends Extract<t.Expression, { kind: "uuid" }>["value"]>(value: Value) => ({
        kind: "uuid" as const,
        value,
    }),
    now: <const Value extends Extract<t.Expression, { kind: "now" }>["value"]>(value: Value) => ({
        kind: "now" as const,
        value,
    }),
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

export const LensOp = {
    move: <const Value extends Extract<t.LensOp, { kind: "move" }>["value"]>(value: Value) => ({
        kind: "move" as const,
        value,
    }),
    select: <const Value extends Extract<t.LensOp, { kind: "select" }>["value"]>(value: Value) => ({
        kind: "select" as const,
        value,
    }),
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
    encrypted,
    ref,
    attachment,
    objectReference,
    unknown,
    StringConstraint,
    AttachmentContentConstraint,
    Expression,
    ActionLogicStep,
    LensOp,
};
