import { describe, expect, it } from "vitest";
import { o, type OntologyAdapter, type OntologyIR } from "@party-stack/ontology";
import { createRemoteOntologyServer } from "./server.js";
import { parseRemoteOntologyJson, serializeRemoteOntologyJson } from "./protocol.js";
import type { RemoteOntologyDescription } from "./protocol.js";

type TestOntology = {
    objectTypes: {
        Note: {
            id: string;
            ownerEmail: string;
        };
    };
    actionTypes: Record<string, { parameters: Record<string, unknown> }>;
};

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
};

describe("remote ontology server policy projection", () => {
    it("describes the secured IR and applies server-owned action parameters last", async () => {
        let appliedParameters: Record<string, unknown> | undefined;
        const adapter: OntologyAdapter = {
            name: "test",
            getCollectionOptions: () => {
                throw new Error("Unexpected collection access.");
            },
            applyAction: async (_actionType, parameters) => {
                appliedParameters = parameters;
            },
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
        ]);

        const applyResponse = await server.handleRequest(
            new Request("http://example.test/apply-action", {
                method: "POST",
                body: serializeRemoteOntologyJson({
                    actionType: "createNote",
                    parameters: {
                        title: "Hello",
                        ownerEmail: "mallory@example.com",
                    },
                }),
            })
        );
        expect(applyResponse.status).toBe(200);
        expect(appliedParameters).toEqual({
            title: "Hello",
            ownerEmail: "alice@example.com",
        });
    });

    it("includes forwarded context in describe and preserves context references", async () => {
        const server = createRemoteOntologyServer<any, TestOntology>({
            ir: {
                ...ir,
                objectTypes: [
                    {
                        name: "Note",
                        displayName: "Note",
                        pluralDisplayName: "Notes",
                        primaryKey: "id",
                        properties: [
                            { name: "id", displayName: "ID", type: o.string({}) },
                            { name: "ownerEmail", displayName: "Owner", type: o.string({}) },
                        ],
                    },
                ],
            },
            adapter: {
                name: "test",
                getCollectionOptions: () => {
                    throw new Error("Unexpected collection access.");
                },
                applyAction: async () => {},
            },
            getContext: () => ({ user: { email: "alice@example.com" }, serviceUser: "svc" }),
            policy: {
                clientContext: "forward",
                allowedObjectTypeProperties: {
                    Note: ["id", "ownerEmail"],
                },
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
        const server = createRemoteOntologyServer<any, TestOntology>({
            ir: {
                ...ir,
                objectTypes: [
                    {
                        name: "Note",
                        displayName: "Note",
                        pluralDisplayName: "Notes",
                        primaryKey: "id",
                        properties: [
                            { name: "id", displayName: "ID", type: o.string({}) },
                            { name: "ownerEmail", displayName: "Owner", type: o.string({}) },
                        ],
                    },
                ],
            },
            adapter: {
                name: "test",
                getCollectionOptions: () => {
                    throw new Error("Unexpected collection access.");
                },
                applyAction: async () => {},
            },
            getContext: () => ({ user: { email: "alice@example.com" }, serviceUser: "svc" }),
            policy: {
                clientContext: (ctx) => ({ user: ctx.user }),
                allowedObjectTypeProperties: {
                    Note: ["id", "ownerEmail"],
                },
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
});
