import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { makeMetadataBackend, pull } from "./meta.js";

const ir: OntologyIR = {
    displayName: "Native metadata",
    context: { type: o.ref({ name: "Identity" }), partition: [["tenant"]] },
    types: [
        {
            name: "Identity",
            type: o.struct({ fields: [{ name: "tenant", displayName: "Tenant", type: o.string({}) }] }),
        },
        { name: "Return", type: o.ref({ name: "Leaf" }) },
        { name: "Leaf", type: o.string({}) },
    ],
    objectTypes: [],
    linkTypes: [],
    queryFunctionTypes: [],
    actionTypes: [
        {
            name: "begin",
            displayName: "Begin",
            parameters: [],
            logic: [],
            returnType: o.ref({ name: "Return" }),
        },
    ],
};

test("native pull needs no replica and includes transitive context and action result types", async () => {
    const result = await Effect.runPromise(
        pull(makeMetadataBackend(ir), {
            objectTypeNames: [],
            actionTypeNames: ["begin"],
            queryFunctionTypeNames: [],
        })
    );
    expect(result.context).toEqual(ir.context);
    expect(result.displayName).toBe(ir.displayName);
    expect(result.actionTypes[0]?.returnType).toEqual(ir.actionTypes[0]?.returnType);
    expect(new Set(result.types.map((type) => type.name))).toEqual(new Set(["Identity", "Return", "Leaf"]));
});

test("native pull rejects incomplete metadata and missing descriptors as typed errors", async () => {
    const backend = makeMetadataBackend(ir);
    for (const loadSubset of [
        () => Effect.succeed({ rows: [], complete: false }),
        () => Effect.succeed({ rows: [], complete: true }),
    ]) {
        const result = await Effect.runPromise(
            pull(
                { ...backend, loadSubset },
                {
                    objectTypeNames: [],
                    actionTypeNames: [],
                    queryFunctionTypeNames: [],
                }
            ).pipe(Effect.result)
        );
        expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "InvalidResponse" } });
    }
});
