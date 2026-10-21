import { Result as EffectResult, Schema } from "effect";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { o } from "../ir/generated/builders.js";
import { compileEffectSchemas } from "./compiler.js";
import type { OntologyIR, TypeDef } from "../ir/generated/types.js";

const field = (name: string, type: TypeDef) => ({ name, displayName: name, type });
const empty: OntologyIR = {
    types: [],
    objectTypes: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
};
const definition = (): OntologyIR => ({
    ...empty,
    types: [
        { name: "Identifier", type: o.integer({}) },
        {
            name: "Node",
            type: o.struct({
                fields: [
                    field("label", o.string({})),
                    field("children", o.list({ elementType: o.ref({ name: "Node" }) })),
                ],
            }),
        },
    ],
    objectTypes: [
        {
            name: "Entry",
            displayName: "Entry",
            pluralDisplayName: "Entries",
            primaryKey: "id",
            properties: [
                field("id", o.ref({ name: "Identifier" })),
                field("parent", o.optional({ type: o.objectReference({ objectType: "Entry" }) })),
                field("tree", o.ref({ name: "Node" })),
                field("outcome", o.result({ okType: o.date({}), errType: o.timestamp({}) })),
                field("dates", o.map({ keyType: o.string({}), valueType: o.timestamp({}) })),
                field("note", o.optional({ type: o.string({}) })),
            ],
        },
    ],
    actionTypes: [
        {
            name: "createEntry",
            displayName: "Create Entry",
            logic: [],
            parameters: [
                { ...field("id", o.integer({})), defaultValue: o.Expression.literal({ value: 1 }) },
                field("at", o.optional({ type: o.timestamp({}) })),
            ],
        },
    ],
    queryFunctionTypes: [
        {
            name: "search",
            displayName: "Search",
            parameters: [field("at", o.optional({ type: o.timestamp({}) }))],
            returnType: o.list({ elementType: o.ref({ name: "Entry" }) }),
        },
    ],
});

describe("runtime Effect schemas", () => {
    it("compiles recursive records, portable Results, Temporal JSON, and action/query parameters", () => {
        const compiled = compileEffectSchemas(definition());
        const schema = compiled.objectSchemas.Entry!;
        const portable = {
            id: 42,
            parent: 1,
            tree: { label: "root", children: [{ label: "leaf", children: [] }] },
            outcome: { kind: "ok", value: Temporal.PlainDate.from("2000-02-29") },
            dates: { created: Temporal.Instant.from("2026-10-19T12:00:00.123456789Z") },
        };
        const value = Schema.decodeUnknownSync(schema)(portable);
        expect(value.outcome).toEqual(EffectResult.succeed(portable.outcome.value));
        expect(Schema.encodeSync(schema)(value)).toEqual(portable);
        const json = Schema.fromJsonString(Schema.toCodecJson(schema));
        const text = Schema.encodeSync(json)(value);
        expect(JSON.parse(text)).toMatchObject({
            outcome: { kind: "ok", value: "2000-02-29" },
            dates: { created: "2026-10-19T12:00:00.123456789Z" },
        });
        expect(Schema.decodeUnknownSync(json)(text)).toEqual(value);
        const failure = { ...value, outcome: EffectResult.fail(portable.dates.created) };
        expect(Schema.decodeUnknownSync(json)(Schema.encodeSync(json)(failure))).toEqual(failure);
        for (const change of [
            { id: "wrong" },
            { parent: "wrong" },
            { id: 2147483648 },
            { note: null },
            { tree: { label: "root", children: [{ label: 1, children: [] }] } },
        ])
            expect(() => Schema.decodeUnknownSync(schema)({ ...portable, ...change })).toThrow(/Expected/);
        expect(Schema.decodeUnknownSync(compiled.actionParameterSchemas.createEntry!)({ at: null })).toEqual({
            at: null,
        });
        expect(Schema.decodeUnknownSync(compiled.actionParameterSchemas.createEntry!)({})).toEqual({});
        expect(() =>
            Schema.decodeUnknownSync(compiled.actionParameterSchemas.createEntry!)({ id: null })
        ).toThrow(/Expected/);
        expect(Schema.decodeUnknownSync(compiled.queryParameterSchemas.search!)({})).toEqual({});
        expect(() => Schema.decodeUnknownSync(compiled.queryParameterSchemas.search!)({ at: null })).toThrow(
            /Expected/
        );
        expect(Schema.decodeUnknownSync(compiled.queryReturnSchemas.search!)([portable])).toEqual([value]);
    });

    it("captures definitions before resolving lazy references and supports arbitrary data-field names", () => {
        const ir = definition();
        ir.objectTypes[0]!.properties.push(field("__proto__", o.string({})));
        const compiled = compileEffectSchemas(ir);
        ir.types[0]!.type = o.string({});
        const schema = compiled.objectSchemas.Entry!;
        const portable = {
            id: 1,
            tree: { label: "root", children: [] },
            dates: {},
            outcome: { kind: "ok", value: Temporal.PlainDate.from("2000-01-01") },
            ["__proto__"]: "ordinary data",
        };
        expect(Schema.encodeSync(schema)(Schema.decodeUnknownSync(schema)(portable))).toEqual(portable);
        expect(() => Schema.decodeUnknownSync(schema)({ ...portable, id: "wrong" })).toThrow(/Expected/);
        expect(Object.isFrozen(compiled.objectSchemas)).toBe(true);
        const arbitrary = compileEffectSchemas({ ...empty, types: [{ name: "a.b", type: o.string({}) }] });
        expect(Schema.decodeUnknownSync(arbitrary.namedSchemas["a.b"]!)("ok")).toBe("ok");
    });

    it("rejects broken references, duplicate names, invalid regexes, and circular reference keys at setup", () => {
        for (const type of [
            o.ref({ name: "Missing" }),
            o.objectReference({ objectType: "Missing" }),
            o.string({ constraint: o.StringConstraint.regex({ regex: "[" }) }),
        ])
            expect(() => compileEffectSchemas({ ...empty, types: [{ name: "Broken", type }] })).toThrow(
                /Unknown ontology type|Cannot resolve primary key|regular expression/i
            );
        const ir = definition();
        ir.types.push({ name: "Identifier", type: o.string({}) });
        expect(() => compileEffectSchemas(ir)).toThrow("Duplicate ontology schema");
        const circular = definition();
        circular.types[0]!.type = o.objectReference({ objectType: "Entry" });
        expect(() => compileEffectSchemas(circular)).toThrow("Circular object reference primary key");
    });
});
