import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { describe, expect, it, vi } from "vite-plus/test";
import { applyActionLogicToMutatorTx } from "./OntologyEdits.js";

describe("applyActionLogicToMutatorTx", () => {
    it("assigns stable temporary string keys to optimistic creates", async () => {
        const create = vi.fn(() => Promise.resolve());
        const ir: OntologyIR = {
            types: [],
            objectTypes: [
                {
                    name: "Task",
                    displayName: "Task",
                    pluralDisplayName: "Tasks",
                    primaryKey: "Id",
                    properties: [
                        {
                            name: "Id",
                            displayName: "ID",
                            type: o.string({}),
                        },
                        {
                            name: "Subject",
                            displayName: "Subject",
                            type: o.string({}),
                        },
                    ],
                },
            ],
            linkTypes: [],
            actionTypes: [
                {
                    name: "createTask",
                    displayName: "Create Task",
                    parameters: [
                        {
                            name: "Subject",
                            displayName: "Subject",
                            type: o.string({}),
                        },
                    ],
                    logic: [
                        {
                            kind: "createObject",
                            value: {
                                objectType: "Task",
                                values: [
                                    {
                                        property: ["Subject"],
                                        value: {
                                            kind: "inputReference",
                                            value: {
                                                name: "Subject",
                                            },
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
            ],
            queryFunctionTypes: [],
        };

        await applyActionLogicToMutatorTx({
            ir,
            actionTypeName: "createTask",
            parameters: { Subject: "Follow up" },
            context: {},
            idempotencyKey: "request-1",
            objects: {},
            tx: {
                mutate: {
                    Task: { create },
                },
            } as never,
        });

        expect(create).toHaveBeenCalledWith({
            Id: "optimistic:request-1:Task:0",
            Subject: "Follow up",
        });
    });
});
