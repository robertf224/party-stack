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

export const file = (value: Extract<t.TypeDef, { kind: "file" }>["value"]) => ({
    kind: "file" as const,
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

export const attachment = (value: Extract<t.TypeDef, { kind: "attachment" }>["value"]) => ({
    kind: "attachment" as const,
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

export const o = {
    string,
    boolean,
    integer,
    float,
    double,
    date,
    timestamp,
    geopoint,
    file,
    list,
    map,
    struct,
    union,
    optional,
    result,
    ref,
    attachment,
    StringConstraint,
};
