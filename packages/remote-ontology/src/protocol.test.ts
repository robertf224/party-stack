import { describe, expect, it } from "vitest";
import { Temporal } from "temporal-polyfill";
import { o, type OntologyIR } from "@party-stack/ontology";
import { createHttpRemoteOntologyTransport } from "./http.js";

describe("createHttpRemoteOntologyTransport", () => {
    it("serializes and hydrates typed ontology values", async () => {
        const ir: OntologyIR = {
            types: [],
            objectTypes: [
                {
                    name: "Task",
                    displayName: "Task",
                    pluralDisplayName: "Tasks",
                    primaryKey: "id",
                    properties: [
                        { name: "id", displayName: "ID", type: o.string({}) },
                        { name: "dueDate", displayName: "Due date", type: o.date({}) },
                    ],
                },
            ],
            linkTypes: [],
            actionTypes: [
                {
                    name: "createTask",
                    displayName: "Create task",
                    parameters: [
                        { name: "id", displayName: "ID", type: o.string({}) },
                        { name: "dueDate", displayName: "Due date", type: o.date({}) },
                    ],
                    logic: [],
                },
            ],
            queryFunctionTypes: [],
        };
        let applyActionBody: unknown;
        const fetchImpl: typeof fetch = async (input, init) => {
            const endpoint = String(input).split("/").pop();
            if (endpoint === "describe") {
                return new Response(JSON.stringify({ ir }));
            }
            if (endpoint === "load-subset") {
                return new Response(
                    JSON.stringify({
                        objectType: "Task",
                        objects: [{ id: "task-1", dueDate: "2026-05-29" }],
                    })
                );
            }
            if (endpoint === "apply-action") {
                applyActionBody = JSON.parse(String(init?.body));
                return new Response(JSON.stringify({}));
            }
            return new Response("Not found", { status: 404 });
        };

        const transport = createHttpRemoteOntologyTransport({
            url: "https://example.test/remote/",
            fetch: fetchImpl,
        });
        await transport.describe();
        const response = await transport.loadSubset({ objectType: "Task" });
        await transport.applyAction({
            actionType: "createTask",
            parameters: {
                id: "task-2",
                dueDate: Temporal.PlainDate.from("2026-05-30"),
            },
        });

        expect(response.objects[0]!.dueDate).toBeInstanceOf(Temporal.PlainDate);
        expect((response.objects[0]!.dueDate as Temporal.PlainDate).equals("2026-05-29")).toBe(true);
        expect(applyActionBody).toEqual({
            actionType: "createTask",
            parameters: {
                id: "task-2",
                dueDate: "2026-05-30",
            },
        });
    });
});
