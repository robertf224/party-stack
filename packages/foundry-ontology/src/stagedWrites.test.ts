import { o } from "@party-stack/ontology";
import { describe, expect, it } from "vitest";
import type { OntologyIR } from "@party-stack/ontology";
import { runFoundryOntologyMutator } from "./stagedWrites.js";
import type { FoundryStagedWriteClient } from "./stagedWrites.js";

const ir: OntologyIR = {
    types: [],
    objectTypes: [
        {
            name: "Task",
            displayName: "Task",
            pluralDisplayName: "Tasks",
            primaryKey: "id",
            properties: [
                {
                    name: "id",
                    displayName: "ID",
                    type: o.string({}),
                },
            ],
        },
    ],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
};

describe("runFoundryOntologyMutator", () => {
    it("writes through the ambient staged-write client", async () => {
        const calls: unknown[] = [];
        const client: FoundryStagedWriteClient = {
            create: (type, object) => {
                calls.push(["create", type, object]);
                return Promise.resolve();
            },
            update: (object, changes) => {
                calls.push(["update", object, changes]);
                return Promise.resolve();
            },
            delete: (object) => {
                calls.push(["delete", object]);
                return Promise.resolve();
            },
        };

        await runFoundryOntologyMutator({
            ir,
            client,
            mutator: async ({ tx }) => {
                await tx.mutate.Task!.create({
                    id: "task-1",
                });
                await tx.mutate.Task!.update("task-1", {
                    title: "Updated",
                });
            },
            args: {},
            objectTypes: {
                Task: "TaskToken",
            },
        });

        expect(calls).toEqual([
            ["create", "TaskToken", { id: "task-1" }],
            [
                "update",
                {
                    $apiName: "Task",
                    $primaryKey: "task-1",
                },
                { title: "Updated" },
            ],
        ]);
    });
});
