import { o, type OntologyIR } from "@party-stack/ontology-spec";
import blog from "@party-stack/ontology-spec/examples/blog";
import metaOntology from "@party-stack/ontology-spec/meta";
import { ontologyDefinitionHash } from "@party-stack/ontology-storage";
import { Effect, Queue, Stream } from "effect";
import { expect, test } from "vitest";
import { loadDefinition, makeMetadataBackend, pull } from "./meta.js";
import { makeOntologyBackend } from "./query.js";
import { objectSubset } from "./subset.js";

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
                    transform: (ontology) => {
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
            transform: async (pulled) => ({ ...pulled, context: ir.context, types: ir.types }),
        })
    );
    expect(result.context).toEqual(ir.context);
    expect(result.types).toEqual(ir.types);
    const invalid = await Effect.runPromise(
        pull(backend, {
            ...options,
            transform: (pulled) => ({ ...pulled, context: ir.context }),
        }).pipe(Effect.result)
    );
    expect(invalid).toMatchObject({ _tag: "Failure", failure: { kind: "InvalidConfiguration" } });
});

test("pull omits definitions the IR cannot represent and reports them, instead of failing the Ontology", async () => {
    const withPrefill: OntologyIR = {
        types: [],
        linkTypes: [],
        queryFunctionTypes: [],
        objectTypes: [
            {
                name: "Facility",
                displayName: "Facility",
                pluralDisplayName: "Facilities",
                primaryKey: "id",
                properties: [
                    { name: "id", displayName: "ID", type: o.string({}) },
                    {
                        name: "coordinates",
                        displayName: "Coordinates",
                        type: o.optional({ type: o.geopoint({}) }),
                    },
                ],
            },
        ],
        actionTypes: [
            {
                name: "editFacility",
                displayName: "Edit Facility",
                parameters: [
                    {
                        name: "facility",
                        displayName: "Facility",
                        type: o.objectReference({ objectType: "Facility" }),
                    },
                    {
                        name: "coordinates",
                        displayName: "Coordinates",
                        type: o.string({}),
                        defaultValue: o.Expression.getAt({
                            source: o.Expression.lookup({
                                reference: o.Expression.inputReference({ name: "facility" }),
                            }),
                            path: ["coordinates"],
                        }),
                    },
                ],
                logic: [],
            },
        ],
    };

    const result = await Effect.runPromise(pull(makeMetadataBackend(withPrefill), { includeOmitted: true }));

    expect(result.ontology.actionTypes[0]?.parameters[1]).toEqual({
        name: "coordinates",
        displayName: "Coordinates",
        type: o.string({}),
    });
    expect(result.omitted).toMatchObject([
        { kind: "defaultValue", section: "actionTypes", name: "editFacility", parameter: "coordinates" },
    ]);

    // Writing that string into the geopoint property is not representable either: the action goes.
    const withWrite: OntologyIR = {
        ...withPrefill,
        actionTypes: withPrefill.actionTypes.map((action) => ({
            ...action,
            logic: [
                o.ActionLogicStep.updateObject({
                    object: { name: "facility" },
                    values: [
                        {
                            property: ["coordinates"],
                            value: o.Expression.inputReference({ name: "coordinates" }),
                        },
                    ],
                }),
            ],
        })),
    };
    const dropped = await Effect.runPromise(pull(makeMetadataBackend(withWrite), { includeOmitted: true }));
    expect(dropped.ontology.actionTypes).toEqual([]);
    expect(dropped.ontology.objectTypes.map((type) => type.name)).toEqual(["Facility"]);
    expect(dropped.omitted).toMatchObject([
        {
            kind: "definition",
            section: "actionTypes",
            name: "editFacility",
            issues: expect.arrayContaining([expect.objectContaining({ code: "IncompatibleAssignment" })]),
        },
    ]);
});

test("a metadata backend reports a replaced definition to its watches", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const replaced = yield* Queue.unbounded<void>();
                const backend = makeMetadataBackend(named, { replaced: Stream.fromQueue(replaced) });
                const watch = yield* backend.watchSubset!(objectSubset("ObjectType"))!;
                const events = yield* Queue.unbounded<unknown>();
                yield* watch.pipe(
                    Stream.runForEach((event) => Queue.offer(events, event)),
                    Effect.forkScoped
                );
                yield* Queue.offer(replaced, undefined);
                expect(yield* Queue.take(events)).toBe("reset");
                expect(makeMetadataBackend(named).watchSubset).toBeUndefined();
            })
        )
    );
});

test("a definition read back from its metadata has the same hash", async () => {
    const definitions = [
        ir,
        blog,
        { ...named, objectTypes: named.objectTypes.map((type) => ({ ...type, id: "provider-item" })) },
    ];
    for (const definition of definitions) {
        const pulled = await Effect.runPromise(pull(makeMetadataBackend(definition)));
        expect(await Effect.runPromise(ontologyDefinitionHash(pulled))).toBe(
            await Effect.runPromise(ontologyDefinitionHash(definition))
        );
    }
});
