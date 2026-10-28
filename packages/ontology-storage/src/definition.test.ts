import { o } from "@party-stack/ontology-spec";
import { OntologyIRSchema } from "@party-stack/ontology-spec/effect";
import { Schema } from "effect";
import { Temporal } from "temporal-polyfill";
import { expect, test } from "vite-plus/test";
import { ontologyDefinitionSignature } from "./definition.js";
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
