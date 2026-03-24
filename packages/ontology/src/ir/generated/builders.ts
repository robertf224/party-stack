// Auto-generated file - do not edit manually

import * as t from "./types.js";

export const string = (value: Extract<t.TypeDef, { kind: "string" }>["value"]) => ({
    kind: "string" as const,
    value,
});

export const boolean = (value: Extract<t.TypeDef, { kind: "boolean" }>["value"]) => ({
    kind: "boolean" as const,
    value,
});

export const integer = (value: Extract<t.TypeDef, { kind: "integer" }>["value"]) => ({
    kind: "integer" as const,
    value,
});

export const float = (value: Extract<t.TypeDef, { kind: "float" }>["value"]) => ({
    kind: "float" as const,
    value,
});

export const double = (value: Extract<t.TypeDef, { kind: "double" }>["value"]) => ({
    kind: "double" as const,
    value,
});

export const date = (value: Extract<t.TypeDef, { kind: "date" }>["value"]) => ({
    kind: "date" as const,
    value,
});

export const timestamp = (value: Extract<t.TypeDef, { kind: "timestamp" }>["value"]) => ({
    kind: "timestamp" as const,
    value,
});

export const geopoint = (value: Extract<t.TypeDef, { kind: "geopoint" }>["value"]) => ({
    kind: "geopoint" as const,
    value,
});

export const attachment = (value: Extract<t.TypeDef, { kind: "attachment" }>["value"]) => ({
    kind: "attachment" as const,
    value,
});

export const list = (value: Extract<t.TypeDef, { kind: "list" }>["value"]) => ({
    kind: "list" as const,
    value,
});

export const map = (value: Extract<t.TypeDef, { kind: "map" }>["value"]) => ({ kind: "map" as const, value });

export const struct = (value: Extract<t.TypeDef, { kind: "struct" }>["value"]) => ({
    kind: "struct" as const,
    value,
});

export const union = (value: Extract<t.TypeDef, { kind: "union" }>["value"]) => ({
    kind: "union" as const,
    value,
});

export const optional = (value: Extract<t.TypeDef, { kind: "optional" }>["value"]) => ({
    kind: "optional" as const,
    value,
});

export const result = (value: Extract<t.TypeDef, { kind: "result" }>["value"]) => ({
    kind: "result" as const,
    value,
});

export const ref = (value: Extract<t.TypeDef, { kind: "ref" }>["value"]) => ({ kind: "ref" as const, value });

export const objectReference = (value: Extract<t.TypeDef, { kind: "objectReference" }>["value"]) => ({
    kind: "objectReference" as const,
    value,
});

export const StringConstraint = {
    enum: (value: Extract<t.StringConstraint, { kind: "enum" }>["value"]) => ({
        kind: "enum" as const,
        value,
    }),
    regex: (value: Extract<t.StringConstraint, { kind: "regex" }>["value"]) => ({
        kind: "regex" as const,
        value,
    }),
};

export const FunctionCallExpression = {
    uuid: (value: Extract<t.FunctionCallExpression, { kind: "uuid" }>["value"]) => ({
        kind: "uuid" as const,
        value,
    }),
    now: (value: Extract<t.FunctionCallExpression, { kind: "now" }>["value"]) => ({
        kind: "now" as const,
        value,
    }),
};

export const Expression = {
    valueReference: (value: Extract<t.Expression, { kind: "valueReference" }>["value"]) => ({
        kind: "valueReference" as const,
        value,
    }),
    contextReference: (value: Extract<t.Expression, { kind: "contextReference" }>["value"]) => ({
        kind: "contextReference" as const,
        value,
    }),
    functionCall: (value: Extract<t.Expression, { kind: "functionCall" }>["value"]) => ({
        kind: "functionCall" as const,
        value,
    }),
};

export const ActionLogicStep = {
    createObject: (value: Extract<t.ActionLogicStep, { kind: "createObject" }>["value"]) => ({
        kind: "createObject" as const,
        value,
    }),
    updateObject: (value: Extract<t.ActionLogicStep, { kind: "updateObject" }>["value"]) => ({
        kind: "updateObject" as const,
        value,
    }),
    deleteObject: (value: Extract<t.ActionLogicStep, { kind: "deleteObject" }>["value"]) => ({
        kind: "deleteObject" as const,
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
    attachment,
    list,
    map,
    struct,
    union,
    optional,
    result,
    ref,
    objectReference,
    StringConstraint,
    FunctionCallExpression,
    Expression,
    ActionLogicStep,
};
