import { describe, expect, it } from "vitest";
import { Temporal } from "temporal-polyfill";
import { o, type OntologyIR } from "@party-stack/ontology";
import { eq, gt, IR } from "@tanstack/db";
import { createHttpRemoteOntologyTransport } from "./http.js";
import { parseRemoteOntologyRequest, serializeLoadSubsetOptions } from "./protocol.js";

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
        let validateActionBody: unknown;
        const fetchImpl: typeof fetch = async (input, init) => {
            const endpoint = String(input).split("/").pop();
            if (endpoint === "describe") {
                return new Response(
                    JSON.stringify({
                        ir,
                        capabilities: {
                            actionValidation: true,
                        },
                    })
                );
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
            if (endpoint === "validate-action") {
                validateActionBody = JSON.parse(String(init?.body));
                return new Response(
                    JSON.stringify({
                        certain: true,
                        value: {
                            kind: "ok",
                            value: null,
                        },
                    })
                );
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
        await expect(
            transport.validateAction!({
                actionType: "createTask",
                parameters: {
                    id: "task-3",
                    dueDate: Temporal.PlainDate.from("2026-05-31"),
                },
            })
        ).resolves.toEqual({
            certain: true,
            value: {
                kind: "ok",
                value: null,
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
        expect(validateActionBody).toEqual({
            actionType: "createTask",
            parameters: {
                id: "task-3",
                dueDate: "2026-05-31",
            },
        });

        let requestedLegacyValidation = false;
        const legacyTransport = createHttpRemoteOntologyTransport({
            url: "https://legacy.example.test/remote/",
            fetch: async (input) => {
                if (String(input).endsWith("/describe")) {
                    return new Response(JSON.stringify({ ir }));
                }
                requestedLegacyValidation = true;
                return new Response("Not found", { status: 404 });
            },
        });
        await legacyTransport.describe();
        await expect(
            legacyTransport.validateAction({
                actionType: "createTask",
                parameters: {},
            })
        ).resolves.toEqual({
            certain: false,
        });
        expect(requestedLegacyValidation).toBe(false);
    });

    it("preserves load subset cursor expressions and removes only subscriptions", () => {
        const where = eq(new IR.PropRef(["status"]), "open");
        const whereFrom = gt(new IR.PropRef(["priority"]), 5);
        const whereCurrent = eq(new IR.PropRef(["priority"]), 5);
        const options = serializeLoadSubsetOptions({
            where,
            cursor: {
                whereFrom,
                whereCurrent,
                lastKey: "task-5",
            },
            offset: 2,
            limit: 3,
            subscription: {} as never,
        });
        const request = parseRemoteOntologyRequest("load-subset", {
            objectType: "Task",
            options,
        });

        expect(options).not.toHaveProperty("subscription");
        expect(request.input).toEqual({
            objectType: "Task",
            options: {
                where,
                cursor: {
                    whereFrom,
                    whereCurrent,
                    lastKey: "task-5",
                },
                offset: 2,
                limit: 3,
            },
        });
    });
});
