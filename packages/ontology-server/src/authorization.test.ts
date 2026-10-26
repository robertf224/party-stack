import { o, type OntologyIR } from "@party-stack/ontology";
import { eq, field, evaluateQuery } from "@party-stack/ontology-storage";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { projectOntologyBackend } from "./authorization.js";
import type { ActionInvocation, OntologyBackendService } from "@party-stack/ontology-backend";

test("projection filters rows before limits, blocks hidden-field probes, and owns fixed parameters", async () => {
    const ir: OntologyIR = {
        types: [],
        linkTypes: [],
        queryFunctionTypes: [],
        actionTypes: [
            {
                name: "save",
                displayName: "Save",
                logic: [],
                parameters: [
                    { name: "id", displayName: "ID", type: o.string({}) },
                    { name: "owner", displayName: "Owner", type: o.string({}) },
                ],
            },
        ],
        objectTypes: [
            {
                name: "Item",
                displayName: "Item",
                pluralDisplayName: "Items",
                primaryKey: "id",
                properties: ["id", "owner", "private"].map((name) => ({
                    name,
                    displayName: name,
                    type: o.string({}),
                })),
            },
        ],
    };
    let applied: ActionInvocation | undefined;
    const backend: OntologyBackendService = {
        name: "test",
        sourceId: "test",
        supportsIdempotency: false,
        loadSubset: (subset) =>
            Effect.succeed({
                rows: evaluateQuery(
                    [
                        { key: "hidden", value: { id: "hidden", owner: "bob", private: "secret" } },
                        { key: "visible", value: { id: "visible", owner: "alice", private: "secret" } },
                    ],
                    subset.query ?? {}
                ),
                complete: true,
            }),
        invoke: (invocation) =>
            Effect.sync(() => {
                applied = invocation;
                return {
                    invocationId: invocation.id,
                    outcome: "committed" as const,
                    affected: [{ objectType: "Private", keys: ["secret"] }],
                };
            }),
        queryFunction: () => Effect.succeed(undefined),
    };
    const view = projectOntologyBackend({
        backend,
        ir,
        context: { user: "alice", secret: "private" },
        policy: {
            allowedObjectTypeProperties: { Item: ["id", "owner"] },
            baseObjectTypeQueries: { Item: eq(field("owner"), "alice") },
            clientContext: (context) => ({ user: context.user }),
            fixedActionParameterValues: {
                save: { owner: { kind: "contextReference", value: { name: "user" } } },
            },
            canApplyAction: (_name, values) => Effect.succeed(values.owner === "alice"),
        },
    });
    expect(view.context).toEqual({ user: "alice" });
    expect(view.ir.actionTypes[0]?.parameters.map((parameter) => parameter.name)).toEqual(["id"]);
    await Effect.runPromise(
        Effect.gen(function* () {
            expect(
                (yield* view.backend.loadSubset({ objectType: "Item", query: { limit: 1 } })).rows
            ).toEqual([{ key: "visible", value: { id: "visible", owner: "alice" } }]);
            expect(
                yield* Effect.result(
                    view.backend.loadSubset({
                        objectType: "Item",
                        query: { where: eq(field("private"), "secret") },
                    })
                )
            ).toMatchObject({ _tag: "Failure", failure: { kind: "NotFound" } });
            const receipt = yield* view.backend.invoke({
                id: "one",
                name: "save",
                parameters: { id: "visible", owner: "bob" },
            });
            expect(applied?.parameters.owner).toBe("alice");
            expect(JSON.stringify(receipt)).not.toMatch(/Private|secret/);
        })
    );
});
