import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { eq } from "@tanstack/db";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { executeTransactionMutator } from "./transactions.js";
import type { OntologyMutator } from "../live/mutators/types.js";
const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    actionTypes: [{ name: "edit", displayName: "Edit", parameters: [], logic: [] }],
    objectTypes: [
        {
            name: "Task",
            displayName: "Task",
            pluralDisplayName: "Tasks",
            primaryKey: "Id",
            properties: [
                { name: "Id", displayName: "Id", type: o.string({}) },
                {
                    name: "settings",
                    displayName: "Settings",
                    type: o.optional({
                        type: o.struct({
                            fields: [
                                {
                                    name: "flag",
                                    displayName: "Flag",
                                    type: o.optional({ type: o.boolean({}) }),
                                },
                                {
                                    name: "nested",
                                    displayName: "Nested",
                                    type: o.optional({
                                        type: o.struct({
                                            fields: [
                                                { name: "flag", displayName: "Flag", type: o.boolean({}) },
                                            ],
                                        }),
                                    }),
                                },
                            ],
                        }),
                    }),
                },
                {
                    name: "labels",
                    displayName: "Labels",
                    type: o.list({
                        elementType: o.struct({
                            fields: [{ name: "name", displayName: "Name", type: o.string({}) }],
                        }),
                    }),
                },
            ],
        },
    ],
};
const setup = Effect.fnUntraced(function* (handler: OntologyMutator) {
    const backend = yield* makeOwnedBackend({
        ir,
        namespace: "bridge",
        tables: yield* Memory.make(),
        mutators: {
            edit: (tx, request) =>
                executeTransactionMutator({
                    ir,
                    tx,
                    name: request.name,
                    parameters: request.parameters,
                    operationId: request.id,
                    mutators: { edit: handler },
                }).pipe(Effect.asVoid),
        },
    });
    yield* backend.storage.transaction((tx) => tx.put("Task", { Id: "one", labels: [] }));
    return backend;
});
test.each([
    { path: ["settings"], value: { flag: true }, expected: { flag: true } },
    { path: ["settings", "nested", "flag"], value: true, expected: { nested: { flag: true } } },
])(
    "the Promise authoring bridge patches absent structures and reads its writes: $path",
    async ({ path, value, expected }) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const backend = yield* setup(async ({ tx }) => {
                        const before = await tx.query<Record<string, unknown>>((q, objects) =>
                            q
                                .from({ task: objects.Task! })
                                .where(({ task }) => eq(task.Id, "one"))
                                .findOne()
                        );
                        expect(before.settings).toBeUndefined();
                        await tx.mutate.Task!.update("one", [{ path, value }]);
                        const after = await tx.query<Record<string, unknown>>((q, objects) =>
                            q
                                .from({ task: objects.Task! })
                                .where(({ task }) => eq(task.Id, "one"))
                                .findOne()
                        );
                        expect(after.settings).toEqual(expected);
                    });
                    yield* backend.applyAction({ id: "edit", name: "edit", parameters: {} });
                    expect(
                        (yield* backend.loadSubset({ objectType: "Task" })).rows[0]?.value.settings
                    ).toEqual(expected);
                })
            )
        );
    }
);
test("invalid structural paths fail without publishing partial writes", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* setup(async ({ tx }) => {
                    await tx.mutate.Task!.update("one", { settings: { flag: true } });
                    await tx.mutate.Task!.update("one", [{ path: ["labels", "name"], value: "invalid" }]);
                });
                expect(
                    (yield* Effect.result(backend.applyAction({ id: "edit", name: "edit", parameters: {} })))
                        ._tag
                ).toBe("Failure");
                expect(
                    (yield* backend.loadSubset({ objectType: "Task" })).rows[0]?.value.settings
                ).toBeUndefined();
            })
        )
    );
});
test("concurrent Promise creates serialize their existence check and roll back a duplicate", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* setup(async ({ tx }) => {
                    await Promise.all([
                        tx.mutate.Task!.create({ Id: "two", labels: [] }),
                        tx.mutate.Task!.create({ Id: "two", labels: [] }),
                    ]);
                });
                expect(
                    yield* Effect.result(backend.applyAction({ id: "edit", name: "edit", parameters: {} }))
                ).toMatchObject({ _tag: "Failure", failure: { kind: "Conflict" } });
                expect((yield* backend.loadSubset({ objectType: "Task" })).rows.map((r) => r.key)).toEqual([
                    "one",
                ]);
            })
        )
    );
});
