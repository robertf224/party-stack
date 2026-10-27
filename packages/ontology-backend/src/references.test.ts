import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { makeOwnedBackend } from "./owned.js";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: ["Project", "Issue"].map((name) => ({
        name,
        displayName: name,
        pluralDisplayName: name,
        primaryKey: "id",
        properties: [{ name: "id", displayName: "ID", type: o.string({}) }],
    })),
    actionTypes: [
        {
            name: "create",
            displayName: "Create",
            logic: [],
            parameters: [
                {
                    name: "project",
                    displayName: "Project",
                    type: o.optional({ type: o.objectReference({ objectType: "Project" }) }),
                },
            ],
        },
    ],
};
test("reference validation is rechecked in the commit transaction and returns parameter paths", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            let applied = 0;
            const owned = yield* makeOwnedBackend({
                namespace: "references",
                ir,
                tables: yield* Memory.make(),
                mutators: {
                    create: (tx) =>
                        Effect.gen(function* () {
                            applied++;
                            yield* tx.put("Issue", { id: "one" });
                        }),
                },
            });
            yield* owned.storage.transaction((tx) => tx.put("Project", { id: "project" }));
            expect(yield* owned.validateAction!("create", { project: "project" })).toEqual({
                certain: false,
            });
            yield* owned.storage.transaction((tx) => tx.delete("Project", "project"));
            const before = yield* owned.loadSubset({ objectType: "Issue" });
            const failure = yield* Effect.result(
                owned.applyAction({ id: "same-action", name: "create", parameters: { project: "project" } })
            );
            expect(failure).toMatchObject({
                _tag: "Failure",
                failure: {
                    kind: "ValidationFailed",
                    actionOutcome: "not-committed",
                    issues: [{ code: "InvalidObjectReference", path: ["project"] }],
                },
            });
            expect(applied).toBe(0);
            expect((yield* owned.changes!.pull({ cursor: before.cursor })).commits).toEqual([]);
            yield* owned.applyAction({ id: "same-action", name: "create", parameters: {} });
            expect(applied).toBe(1);
        })
    );
});
