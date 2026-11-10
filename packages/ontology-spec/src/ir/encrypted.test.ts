import { assert, it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect, test } from "vitest";
import { nestedEncryptedIssues } from "./encrypted.js";
import { o } from "./generated/builders.js";
import definition from "./schema.js";
import type { ValidationIssue } from "../utils/validation.js";
import type { OntologyIR, TypeDef } from "./generated/types.js";

// Independent oracle: the original reference-expanding traversal, retained unchanged.
function originalNestedEncryptedIssues(ir: OntologyIR): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const definitions = new Map(ir.types.map((entry) => [entry.name, entry.type]));
    function visit(type: TypeDef, path: (string | number)[], encrypted = false, refs = new Set<string>()) {
        const child = (value: TypeDef, key: string) => visit(value, [...path, "value", key], encrypted, refs);
        switch (type.kind) {
            case "encrypted":
                if (encrypted)
                    issues.push({
                        message: "Encrypted values cannot contain another encrypted wrapper.",
                        path,
                    });
                else visit(type.value.type, [...path, "value", "type"], true, refs);
                break;
            case "ref": {
                const name = type.value.name;
                const value = definitions.get(name);
                if (value && !refs.has(name)) visit(value, path, encrypted, new Set([...refs, name]));
                break;
            }
            case "optional":
                child(type.value.type, "type");
                break;
            case "list":
                child(type.value.elementType, "elementType");
                break;
            case "map":
                child(type.value.keyType, "keyType");
                child(type.value.valueType, "valueType");
                break;
            case "result":
                child(type.value.okType, "okType");
                child(type.value.errType, "errType");
                break;
            case "struct":
                type.value.fields.forEach((field, index) =>
                    visit(field.type, [...path, "value", "fields", index, "type"], encrypted, refs)
                );
                break;
            case "union":
                type.value.variants.forEach((variant, index) =>
                    visit(variant.type, [...path, "value", "variants", index, "type"], encrypted, refs)
                );
                break;
        }
    }
    if (ir.context?.type) visit(ir.context?.type, ["context", "type"]);
    ir.types.forEach((entry, index) => visit(entry.type, ["types", index, "type"]));
    ir.objectTypes.forEach((object, index) =>
        object.properties.forEach((property, propertyIndex) =>
            visit(property.type, ["objectTypes", index, "properties", propertyIndex, "type"])
        )
    );
    ir.actionTypes.forEach((action, index) => {
        if (action.returnType) visit(action.returnType, ["actionTypes", index, "returnType"]);
        action.parameters.forEach((parameter, parameterIndex) =>
            visit(parameter.type, ["actionTypes", index, "parameters", parameterIndex, "type"])
        );
    });
    ir.queryFunctionTypes.forEach((query, index) => {
        query.parameters.forEach((parameter, parameterIndex) =>
            visit(parameter.type, ["queryFunctionTypes", index, "parameters", parameterIndex, "type"])
        );
        visit(query.returnType, ["queryFunctionTypes", index, "returnType"]);
    });
    return issues;
}

const empty = (): OntologyIR => ({
    types: [],
    objectTypes: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
});
const field = (name: string, type: TypeDef) => ({ name, displayName: name, type });
const nested = () => o.encrypted({ type: o.encrypted({ type: o.string({}) }) });
const rootCases: { name: string; path: (string | number)[]; ir: OntologyIR }[] = [
    { name: "context", path: ["context", "type"], ir: { ...empty(), context: { type: nested() } } },
    {
        name: "named type",
        path: ["types", 0, "type"],
        ir: { ...empty(), types: [{ name: "Secret", type: nested() }] },
    },
    {
        name: "object property",
        path: ["objectTypes", 0, "properties", 0, "type"],
        ir: {
            ...empty(),
            objectTypes: [
                {
                    name: "Item",
                    displayName: "Item",
                    pluralDisplayName: "Items",
                    primaryKey: "value",
                    properties: [field("value", nested())],
                },
            ],
        },
    },
    {
        name: "action parameter",
        path: ["actionTypes", 0, "parameters", 0, "type"],
        ir: {
            ...empty(),
            actionTypes: [
                { name: "act", displayName: "Act", parameters: [field("value", nested())], logic: [] },
            ],
        },
    },
    {
        name: "action return",
        path: ["actionTypes", 0, "returnType"],
        ir: {
            ...empty(),
            actionTypes: [
                { name: "act", displayName: "Act", parameters: [], logic: [], returnType: nested() },
            ],
        },
    },
    {
        name: "query parameter",
        path: ["queryFunctionTypes", 0, "parameters", 0, "type"],
        ir: {
            ...empty(),
            queryFunctionTypes: [
                {
                    name: "query",
                    displayName: "Query",
                    parameters: [field("value", nested())],
                    returnType: o.string({}),
                },
            ],
        },
    },
    {
        name: "query return",
        path: ["queryFunctionTypes", 0, "returnType"],
        ir: {
            ...empty(),
            queryFunctionTypes: [
                { name: "query", displayName: "Query", parameters: [], returnType: nested() },
            ],
        },
    },
];
test.each(rootCases)("finds encrypted wrappers in $name without losing their issue path", ({ ir, path }) => {
    expect(nestedEncryptedIssues(ir)).toEqual([
        {
            message: "Encrypted values cannot contain another encrypted wrapper.",
            path: [...path, "value", "type"],
        },
    ]);
});

test("inline encryption beneath every structural wrapper retains its exact issue path", () => {
    const types = [
        o.optional({ type: nested() }),
        o.list({ elementType: nested() }),
        o.map({ keyType: nested(), valueType: o.string({}) }),
        o.map({ keyType: o.string({}), valueType: nested() }),
        o.result({ okType: nested(), errType: o.string({}) }),
        o.result({ okType: o.string({}), errType: nested() }),
        o.struct({ fields: [field("value", nested())] }),
        o.union({ variants: [{ name: "value", type: nested() }] }),
    ];
    for (const type of types) {
        const ir = { ...empty(), types: [{ name: "Wrapped", type }] };
        const issues = nestedEncryptedIssues(ir);
        expect(issues).toHaveLength(1);
        expect(issues).toEqual(originalNestedEncryptedIssues(ir));
    }
});

test("the self-describing IR contains no actual encrypted wrappers", () => {
    expect(originalNestedEncryptedIssues(definition)).toEqual([]);
    expect(nestedEncryptedIssues(definition)).toEqual([]);
});

test("unencrypted named reference graphs do not expand any references", () => {
    let expansions = 0;
    const ref = (name: string): TypeDef => ({
        kind: "ref",
        value: {
            get name() {
                expansions++;
                return name;
            },
        },
    });
    const ir: OntologyIR = {
        ...empty(),
        types: Array.from({ length: 12 }, (_, index) => ({
            name: `T${index}`,
            type:
                index === 11
                    ? o.string({})
                    : o.struct({
                          fields: [field("left", ref(`T${index + 1}`)), field("right", ref(`T${index + 1}`))],
                      }),
        })),
    };
    expect(nestedEncryptedIssues(ir)).toEqual([]);
    expect(expansions).toBe(0);
    expect(originalNestedEncryptedIssues(ir)).toEqual([]);
    expect(expansions).toBeGreaterThan(1000);
});

test("cyclic references retain encryption context and repeated issue paths", () => {
    const ir: OntologyIR = {
        ...empty(),
        types: [
            { name: "A", type: o.encrypted({ type: o.ref({ name: "B" }) }) },
            {
                name: "B",
                type: o.struct({
                    fields: [
                        field("loop", o.ref({ name: "A" })),
                        field("left", o.encrypted({ type: o.string({}) })),
                        field("right", o.encrypted({ type: o.string({}) })),
                    ],
                }),
            },
        ],
        context: { type: o.ref({ name: "A" }) },
    };
    const expected = originalNestedEncryptedIssues(ir);
    expect(expected.length).toBeGreaterThan(4);
    expect(nestedEncryptedIssues(ir)).toEqual(expected);
});

const seedSchema = Schema.Struct({
    kind: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 11 })),
    left: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
    right: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
});
type Seed = Schema.Schema.Type<typeof seedSchema>;
const generator = Arbitrary.schema(
    Schema.Struct({
        types: Schema.Array(seedSchema).check(Schema.isMaxLength(7)),
        roots: Schema.Array(seedSchema).check(Schema.isMaxLength(5)),
        encryptedRoots: Schema.Boolean,
    })
);
function fromSeed(seed: Seed): TypeDef {
    const left = seed.left === 6 ? nested() : o.ref({ name: `T${seed.left}` });
    const right = seed.right === 6 ? nested() : o.ref({ name: `T${seed.right}` });
    switch (seed.kind) {
        case 0:
            return o.string({});
        case 1:
            return left;
        case 2:
            return o.encrypted({ type: left });
        case 3:
            return o.optional({ type: left });
        case 4:
            return o.list({ elementType: left });
        case 5:
            return o.map({ keyType: left, valueType: right });
        case 6:
            return o.result({ okType: left, errType: right });
        case 7:
            return o.struct({ fields: [field("left", left), field("right", right)] });
        case 8:
            return o.union({
                variants: [
                    { name: "left", type: left },
                    { name: "right", type: right },
                ],
            });
        case 9:
            return nested();
        case 10:
            return o.objectReference({ objectType: "Item" });
        default:
            return o.struct({
                fields: [
                    field("left", o.list({ elementType: left })),
                    field("right", o.optional({ type: right })),
                ],
            });
    }
}
it.effect.prop(
    "arbitrary reference graphs preserve exact issues, order, paths and cycle boundaries",
    [generator],
    ([input]) =>
        Effect.try(() => {
            const roots = input.roots.map((seed) => {
                const type = fromSeed(seed);
                return input.encryptedRoots ? o.encrypted({ type }) : type;
            });
            const ir: OntologyIR = {
                types: input.types.map((seed, index) => ({ name: `T${index}`, type: fromSeed(seed) })),
                objectTypes: [
                    {
                        name: "Item",
                        displayName: "Item",
                        pluralDisplayName: "Items",
                        primaryKey: "f0",
                        properties: roots.map((type, index) => field(`f${index}`, type)),
                    },
                ],
                linkTypes: [],
                actionTypes: roots.map((type, index) => ({
                    name: `action${index}`,
                    displayName: "Action",
                    parameters: [field("value", type)],
                    returnType: type,
                    logic: [],
                })),
                queryFunctionTypes: roots.map((type, index) => ({
                    name: `query${index}`,
                    displayName: "Query",
                    parameters: [field("value", type)],
                    returnType: type,
                })),
                ...(roots[0] ? { context: { type: roots[0] } } : {}),
            };
            assert.deepStrictEqual(nestedEncryptedIssues(ir), originalNestedEncryptedIssues(ir));
        }),
    { arbitrary: { runs: 300, size: 15, seed: "nested-encryption-prepass-v1" } }
);
