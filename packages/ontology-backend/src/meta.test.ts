import { o, type OntologyIR } from "@party-stack/ontology-spec";
import metaOntology from "@party-stack/ontology-spec/meta";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { loadDefinition, makeMetadataBackend, pull } from "./meta.js";
import { makeOntologyBackend } from "./query.js";

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
const named: OntologyIR = {
    ...ir,
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [{ name: "id", displayName: "Id", type: o.string({}) }],
        },
    ],
    queryFunctionTypes: [
        {
            name: "echo",
            displayName: "Echo",
            parameters: [],
            returnType: o.string({}),
        },
    ],
};

test("runtime definition loading includes all entity kinds and their type dependencies", async () => {
    const actual = await Effect.runPromise(loadDefinition(makeMetadataBackend(named)));
    expect(actual.objectTypes.map((type) => type.name)).toEqual(["Item"]);
    expect(actual.actionTypes.map((type) => type.name)).toEqual(["begin"]);
    expect(actual.queryFunctionTypes.map((type) => type.name)).toEqual(["echo"]);
    expect(actual.types.map((type) => type.name).sort()).toEqual(["Identity", "Leaf", "Return"]);
    expect(actual.context).toEqual(named.context);
});

test.each([
    ["objectTypeNames", "MissingObject", "object types"],
    ["actionTypeNames", "MissingAction", "action types"],
    ["queryFunctionTypeNames", "MissingQuery", "query function types"],
] as const)(
    "pull rejects an omitted requested %s before dependencies or an app transform",
    async (option, name, kind) => {
        const backend = makeMetadataBackend(named);
        let queries = 0;
        let transformed = false;
        const options = {
            objectTypeNames: ["Item"],
            actionTypeNames: ["begin"],
            queryFunctionTypeNames: ["echo"],
        };
        options[option].push(name);
        const result = await Effect.runPromise(
            pull(
                {
                    query: (request) => {
                        queries++;
                        return backend.query(request);
                    },
                },
                {
                    ...options,
                    transformPulledOntology: (ontology) => {
                        transformed = true;
                        return ontology;
                    },
                }
            ).pipe(Effect.result)
        );
        expect(result).toMatchObject({
            _tag: "Failure",
            failure: {
                operation: "metadata.pull",
                kind: "InvalidResponse",
                retryable: false,
                message: `Missing requested metadata ${kind}: ${name}.`,
            },
        });
        expect(queries).toBe(1);
        expect(transformed).toBe(false);
    }
);

test("pull accepts duplicate requested names without requiring duplicate definitions", async () => {
    const result = await Effect.runPromise(
        pull(makeMetadataBackend(named), {
            objectTypeNames: ["Item", "Item"],
            actionTypeNames: ["begin", "begin"],
            queryFunctionTypeNames: ["echo", "echo"],
        })
    );
    expect(result.objectTypes.map((type) => type.name)).toEqual(["Item"]);
    expect(result.actionTypes.map((type) => type.name)).toEqual(["begin"]);
    expect(result.queryFunctionTypes.map((type) => type.name)).toEqual(["echo"]);
});

test("pull accepts a legitimate empty selection", async () => {
    const empty: OntologyIR = {
        types: [],
        objectTypes: [],
        linkTypes: [],
        actionTypes: [],
        queryFunctionTypes: [],
    };
    const result = await Effect.runPromise(
        pull(makeMetadataBackend(empty), {
            objectTypeNames: [],
            actionTypeNames: [],
            queryFunctionTypeNames: [],
        })
    );
    expect(result).toEqual(empty);
});

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
            pull(makeOntologyBackend({ ...backend, ir: metaOntology, query: undefined, loadSubset }), {
                objectTypeNames: [],
                actionTypeNames: [],
                queryFunctionTypeNames: [],
            }).pipe(Effect.result)
        );
        expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "InvalidResponse" } });
    }
});

test("pull validates after an app transform and rejects invalid transformed definitions", async () => {
    const backend = makeMetadataBackend({
        ...ir,
        types: [],
        actionTypes: [],
        context: {
            type: o.struct({
                fields: [
                    { name: "user", displayName: "User", type: o.objectReference({ objectType: "User" }) },
                ],
            }),
        },
    });
    const options = { objectTypeNames: [], actionTypeNames: [], queryFunctionTypeNames: [] };
    const result = await Effect.runPromise(
        pull(backend, {
            ...options,
            transformPulledOntology: async (pulled) => ({ ...pulled, context: ir.context, types: ir.types }),
        })
    );
    expect(result.context).toEqual(ir.context);
    expect(result.types).toEqual(ir.types);
    const invalid = await Effect.runPromise(
        pull(backend, {
            ...options,
            transformPulledOntology: (pulled) => ({ ...pulled, context: ir.context }),
        }).pipe(Effect.result)
    );
    expect(invalid).toMatchObject({ _tag: "Failure", failure: { kind: "InvalidConfiguration" } });
});
