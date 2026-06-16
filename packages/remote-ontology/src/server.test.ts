import { describe, expect, it } from "vitest";
import { Temporal } from "temporal-polyfill";
import {
    o,
    type OntologyAdapter,
    type OntologyIR,
} from "@party-stack/ontology";
import { createRemoteOntologyServer } from "./server.js";
import { parseRemoteOntologyJson, serializeRemoteOntologyJson } from "./protocol.js";
import type { RemoteOntologyDescription } from "./protocol.js";

const ir: OntologyIR = {
    types: [],
    objectTypes: [],
    linkTypes: [],
    actionTypes: [
        {
            name: "createNote",
            displayName: "Create note",
            parameters: [
                { name: "title", displayName: "Title", type: o.string({}) },
                { name: "ownerEmail", displayName: "Owner", type: o.string({}) },
                { name: "dueDate", displayName: "Due date", type: o.date({}) },
            ],
            logic: [],
        },
        {
            name: "createContextNote",
            displayName: "Create context note",
            parameters: [
                { name: "title", displayName: "Title", type: o.string({}) },
            ],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "Note",
                    values: [
                        {
                            property: ["ownerEmail"],
                            value: o.Expression.contextReference({ path: ["user", "email"] }),
                        },
                    ],
                }),
            ],
        },
    ],
    queryFunctionTypes: [
        {
            name: "greet",
            displayName: "Greet",
            parameters: [{ name: "name", displayName: "Name", type: o.string({}) }],
            returnType: o.string({}),
        },
    ],
};

const noteObjectType: OntologyIR["objectTypes"][number] = {
    name: "Note",
    displayName: "Note",
    pluralDisplayName: "Notes",
    primaryKey: "id",
    properties: [
        { name: "id", displayName: "ID", type: o.string({}) },
        { name: "ownerEmail", displayName: "Owner", type: o.string({}) },
    ],
};

function readyCollectionOptions(): ReturnType<OntologyAdapter["getCollectionOptions"]> {
    return {
        syncMode: "eager",
        sync: {
            sync: ({ markReady }) => {
                markReady();
            },
        },
    };
}

describe("remote ontology server policy projection", () => {
    it("describes the secured IR and applies server-owned action parameters last", async () => {
        let appliedParameters: Record<string, unknown> | undefined;
        const adapter: OntologyAdapter = {
            name: "test",
            getCollectionOptions: readyCollectionOptions,
            applyAction: async (_actionType, parameters) => {
                appliedParameters = parameters;
            },
            runQueryFunction: async (_queryFunctionType, parameters) => `Hello ${parameters.name}`,
        };
        const server = createRemoteOntologyServer<any, any>({
            ir,
            adapter,
            getContext: () => ({ user: { email: "alice@example.com" } }),
            policy: {
                canApplyAction: () => true,
                fixedActionParameterValues: {
                    createNote: {
                        ownerEmail: o.Expression.contextReference({ path: ["user", "email"] }),
                    },
                },
            },
        });

        const describeResponse = await server.handleRequest(
            new Request("http://example.test/describe", {
                method: "POST",
                body: serializeRemoteOntologyJson({}),
            })
        );
        expect(describeResponse.status).toBe(200);
        const description = parseRemoteOntologyJson(await describeResponse.text()) as RemoteOntologyDescription;
        expect(description.ir.actionTypes[0]!.parameters.map((parameter) => parameter.name)).toEqual([
            "title",
            "dueDate",
        ]);

        const applyResponse = await server.handleRequest(
            new Request("http://example.test/apply-action", {
                method: "POST",
                body: serializeRemoteOntologyJson({
                    actionType: "createNote",
                    parameters: {
                        title: "Hello",
                        ownerEmail: "mallory@example.com",
                        dueDate: "2026-06-15",
                    },
                }),
            })
        );
        expect(applyResponse.status).toBe(200);
        expect(appliedParameters).toEqual({
            title: "Hello",
            ownerEmail: "alice@example.com",
            dueDate: Temporal.PlainDate.from("2026-06-15"),
        });
    });

    it("includes forwarded context in describe and preserves context references", async () => {
        const server = createRemoteOntologyServer<any, any>({
            ir: {
                ...ir,
                objectTypes: [noteObjectType],
            },
            adapter: {
                name: "test",
                getCollectionOptions: readyCollectionOptions,
                applyAction: async () => {},
                runQueryFunction: async () => undefined,
            },
            getContext: () => ({ user: { email: "alice@example.com" }, serviceUser: "svc" }),
            policy: {
                clientContext: "forward",
                allowedObjectTypeProperties: {
                    Note: ["id", "ownerEmail"],
                } as any,
            },
        });

        const response = await server.handleRequest(
            new Request("http://example.test/describe", {
                method: "POST",
                body: serializeRemoteOntologyJson({}),
            })
        );
        const description = parseRemoteOntologyJson(await response.text()) as RemoteOntologyDescription;
        const action = description.ir.actionTypes.find((action) => action.name === "createContextNote")!;
        const step = action.logic[0]!;
        expect(description.context).toEqual({
            user: { email: "alice@example.com" },
            serviceUser: "svc",
        });
        expect(step.kind).toBe("createObject");
        if (step.kind !== "createObject") return;
        expect(step.value.values).toEqual([
            {
                property: ["ownerEmail"],
                value: o.Expression.contextReference({ path: ["user", "email"] }),
            },
        ]);
    });

    it("returns projected context without preserving source context references", async () => {
        const server = createRemoteOntologyServer<any, any>({
            ir: {
                ...ir,
                objectTypes: [noteObjectType],
            },
            adapter: {
                name: "test",
                getCollectionOptions: readyCollectionOptions,
                applyAction: async () => {},
                runQueryFunction: async () => undefined,
            },
            getContext: () => ({ user: { email: "alice@example.com" }, serviceUser: "svc" }),
            policy: {
                clientContext: (ctx) => ({ user: ctx.user }),
                allowedObjectTypeProperties: {
                    Note: ["id", "ownerEmail"],
                } as any,
            },
        });

        const response = await server.handleRequest(
            new Request("http://example.test/describe", {
                method: "POST",
                body: serializeRemoteOntologyJson({}),
            })
        );
        const description = parseRemoteOntologyJson(await response.text()) as RemoteOntologyDescription;
        const action = description.ir.actionTypes.find((action) => action.name === "createContextNote")!;
        const step = action.logic[0]!;
        expect(description.context).toEqual({
            user: { email: "alice@example.com" },
        });
        expect(step.kind).toBe("createObject");
        if (step.kind !== "createObject") return;
        expect(step.value.values).toEqual([]);
    });

    it("runs query functions through the remote query function endpoint", async () => {
        const server = createRemoteOntologyServer<any, any>({
            ir,
            adapter: {
                name: "test",
                getCollectionOptions: readyCollectionOptions,
                applyAction: async () => {},
                runQueryFunction: async (_queryFunctionType, parameters) => `Hello ${parameters.name}`,
            },
            policy: {
                canRunQueryFunction: () => true,
            },
        });

        const response = await server.handleRequest(
            new Request("http://example.test/run-query-function", {
                method: "POST",
                body: serializeRemoteOntologyJson({
                    queryFunctionType: "greet",
                    parameters: { name: "Alice" },
                }),
            })
        );

        expect(response.status).toBe(200);
        expect(parseRemoteOntologyJson(await response.text())).toEqual({ value: "Hello Alice" });
    });
});
