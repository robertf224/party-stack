import { it } from "@effect/vitest";
import { o } from "@party-stack/ontology-spec";
import { OntologyIRSchema } from "@party-stack/ontology-spec/effect";
import { Arbitrary, Effect, Schema } from "effect";
import { Temporal } from "temporal-polyfill";
import { expect, test } from "vite-plus/test";
import { ontologyDefinitionContractSignature, ontologyDefinitionSignature } from "./definition.js";
import type { OntologyIR } from "@party-stack/ontology-spec";

const definition: OntologyIR = {
    objectTypes: [],
    actionTypes: [],
    linkTypes: [],
    queryFunctionTypes: [],
    types: [],
};

test("definition identity survives wire decoding and reordered object keys", () => {
    const decoded = Schema.decodeUnknownSync(OntologyIRSchema)(definition);
    const reordered = Object.fromEntries(Object.entries(decoded).reverse()) as OntologyIR;
    expect(ontologyDefinitionSignature(reordered)).toBe(ontologyDefinitionSignature(definition));
});

test("definition identity preserves typed literal values and meaningful array order", () => {
    const withValue = (value: unknown): OntologyIR => ({
        ...definition,
        actionTypes: [
            {
                name: "test",
                displayName: "Test",
                parameters: [
                    {
                        name: "input",
                        displayName: "Input",
                        type: o.optional({ type: o.timestamp({}) }),
                        defaultValue: o.Expression.literal({ value }),
                    },
                ],
                logic: [],
            },
        ],
    });
    const instant = Temporal.Instant.from("2026-10-28T00:00:00Z");
    expect(ontologyDefinitionSignature(withValue(instant))).not.toBe(
        ontologyDefinitionSignature(withValue(String(instant)))
    );
    expect(ontologyDefinitionSignature(withValue([1, 2]))).not.toBe(
        ontologyDefinitionSignature(withValue([2, 1]))
    );
});

const decorated = (label: string): OntologyIR => ({
    ...definition,
    displayName: label,
    description: label,
    types: [
        {
            name: "Details",
            description: label,
            type: o.struct({
                fields: [
                    {
                        name: "state",
                        displayName: label,
                        description: label,
                        type: o.string({
                            suggestions: [{ value: label, label }],
                            constraint: o.StringConstraint.enum({ options: [{ value: "open", label }] }),
                        }),
                    },
                ],
            }),
        },
    ],
    objectTypes: [
        {
            name: "Item",
            displayName: label,
            pluralDisplayName: label,
            primaryKey: "id",
            description: label,
            title: label === "Old" ? "id" : "details",
            color: label,
            icon: { name: label === "Old" ? "document" : "folder" },
            properties: [
                { name: "id", displayName: label, description: label, type: o.string({}) },
                { name: "details", displayName: label, type: o.ref({ name: "Details" }) },
            ],
        },
    ],
    linkTypes: [
        {
            id: "related",
            source: { objectType: "Item", name: "children", displayName: label },
            target: { objectType: "Item", name: "parent", displayName: label },
            foreignKey: "id",
            cardinality: "many",
        },
    ],
    actionTypes: [
        {
            name: "write",
            displayName: label,
            description: label,
            parameters: [
                {
                    name: "input",
                    displayName: label,
                    description: label,
                    type: o.string({}),
                    defaultValue: o.Expression.literal({ value: { title: "data", description: "data" } }),
                },
            ],
            logic: [],
            returnType: o.struct({ fields: [{ name: "result", displayName: label, type: o.boolean({}) }] }),
        },
    ],
    queryFunctionTypes: [
        {
            name: "read",
            displayName: label,
            description: label,
            parameters: [{ name: "input", displayName: label, type: o.string({}) }],
            returnType: o.list({
                elementType: o.struct({
                    fields: [{ name: "value", displayName: label, type: o.string({}) }],
                }),
            }),
        },
    ],
    context: { type: o.struct({ fields: [{ name: "user", displayName: label, type: o.string({}) }] }) },
    policy: { objects: { inputs: [{ name: "input", displayName: label, type: o.string({}) }], select: [] } },
});

test("contract identity ignores presentation only on explicitly known definition nodes", () => {
    expect(ontologyDefinitionSignature(decorated("Old"))).not.toBe(
        ontologyDefinitionSignature(decorated("New"))
    );
    expect(ontologyDefinitionContractSignature(decorated("Old"))).toBe(
        ontologyDefinitionContractSignature(decorated("New"))
    );
});

test("contract identity preserves property types, enum values, provider metadata and policy", () => {
    const original = decorated("Old");
    const signature = ontologyDefinitionContractSignature(original);
    for (const changed of [
        {
            ...original,
            objectTypes: original.objectTypes.map((object) => ({ ...object, primaryKey: "details" })),
        },
        { ...original, types: [{ ...original.types[0]!, type: o.integer({}) }] },
        {
            ...original,
            types: [
                {
                    ...original.types[0]!,
                    type: o.string({
                        constraint: o.StringConstraint.enum({ options: [{ value: "closed", label: "Old" }] }),
                    }),
                },
            ],
        },
        {
            ...original,
            types: [{ ...original.types[0]!, type: o.attachment({ meta: { description: "provider" } }) }],
        },
        {
            ...original,
            policy: {
                objects: {
                    select: [
                        o.QuerySelection.field({
                            name: "title",
                            expression: o.Expression.literal({ value: "allowed" }),
                        }),
                    ],
                },
            },
        },
    ] satisfies OntologyIR[])
        expect(ontologyDefinitionContractSignature(changed)).not.toBe(signature);
});

const withLiteral = (value: unknown): OntologyIR => ({
    ...definition,
    actionTypes: [
        {
            name: "write",
            displayName: "Write",
            parameters: [
                {
                    name: "input",
                    displayName: "Input",
                    type: o.string({}),
                    defaultValue: o.Expression.literal({ value }),
                },
            ],
            logic: [],
        },
    ],
});
it.effect.prop(
    "metadata-named literal properties remain contract-significant at arbitrary nested paths",
    [Arbitrary.schema(Schema.Array(Schema.String).check(Schema.isMaxLength(8)))],
    ([path]) =>
        Effect.try(() => {
            const nested = (description: string) =>
                path.reduce<unknown>((value, key) => ({ [key]: value }), {
                    title: "same",
                    color: "same",
                    description,
                });
            expect(ontologyDefinitionContractSignature(withLiteral(nested("a")))).not.toBe(
                ontologyDefinitionContractSignature(withLiteral(nested("b")))
            );
        }),
    { arbitrary: { runs: 50, seed: "definition-contract-literals-v1" } }
);

test("signatures are computed once per definition object", () => {
    const original = decorated("Cached");
    let reads = 0;
    const counted = { ...original };
    Object.defineProperty(counted, "objectTypes", {
        enumerable: true,
        get: () => {
            reads++;
            return original.objectTypes;
        },
    });
    const signature = ontologyDefinitionSignature(counted);
    const contract = ontologyDefinitionContractSignature(counted);
    const afterFirst = reads;
    expect(afterFirst).toBeGreaterThan(0);
    expect(ontologyDefinitionSignature(counted)).toBe(signature);
    expect(ontologyDefinitionContractSignature(counted)).toBe(contract);
    expect(reads).toBe(afterFirst);
    // Equal definitions in other objects still produce the same identities.
    expect(ontologyDefinitionSignature(structuredClone(original))).toBe(signature);
    expect(ontologyDefinitionContractSignature(structuredClone(original))).toBe(contract);
});
