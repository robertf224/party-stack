import { describe, expect, it } from "vitest";
import { Temporal } from "temporal-polyfill";
import {
    o,
    type OntologyBackendAdapter,
    type OntologyIR,
} from "@party-stack/ontology";
import { eq, gt, IR, queryOnce } from "@tanstack/db";
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
        { name: "status", displayName: "Status", type: o.string({}) },
        { name: "priority", displayName: "Priority", type: o.integer({}) },
    ],
};

function readyCollectionOptions(): ReturnType<OntologyBackendAdapter["getCollectionOptions"]> {
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
        let validatedParameters: Record<string, unknown> | undefined;
        const backendAdapter: OntologyBackendAdapter = {
            name: "test",
            getCollectionOptions: readyCollectionOptions,
            applyAction: async (_actionType, parameters) => {
                appliedParameters = parameters;
            },
            validateAction: async (_actionType, parameters) => {
                validatedParameters = parameters;
                return {
                    certain: true,
                    value: {
                        kind: "ok",
                        value: undefined,
                    },
                };
            },
            runQueryFunction: async (_queryFunctionType, parameters) => `Hello ${parameters.name}`,
        };
        const server = createRemoteOntologyServer<any, any>({
            ir,
            backendAdapter,
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
        expect(description.capabilities).toEqual({
            actionValidation: true,
        });
        expect(description.ir.actionTypes[0]!.parameters.map((parameter) => parameter.name)).toEqual([
            "title",
            "dueDate",
        ]);

        const validateResponse = await server.handleRequest(
            new Request("http://example.test/validate-action", {
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
        expect(validateResponse.status).toBe(200);
        expect(parseRemoteOntologyJson(await validateResponse.text())).toEqual({
            certain: true,
            value: {
                kind: "ok",
                value: null,
            },
        });
        expect(validatedParameters).toEqual({
            title: "Hello",
            ownerEmail: "alice@example.com",
            dueDate: Temporal.PlainDate.from("2026-06-15"),
        });

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
            backendAdapter: {
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
            backendAdapter: {
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
            backendAdapter: {
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

    it("composes policy, where, cursor, ordering, offset, and limit once", async () => {
        const notes = [
            { id: "one", ownerEmail: "alice@example.com", status: "open", priority: 1 },
            { id: "two", ownerEmail: "alice@example.com", status: "open", priority: 3 },
            { id: "three", ownerEmail: "alice@example.com", status: "open", priority: 5 },
            { id: "four", ownerEmail: "alice@example.com", status: "open", priority: 7 },
            { id: "closed", ownerEmail: "alice@example.com", status: "closed", priority: 4 },
            { id: "other-owner", ownerEmail: "bob@example.com", status: "open", priority: 2 },
        ];
        const backendAdapter: OntologyBackendAdapter = {
            name: "test",
            getCollectionOptions: () => ({
                syncMode: "eager",
                sync: {
                    sync: ({ begin, write, commit, markReady }) => {
                        begin();
                        for (const note of notes) {
                            write({ type: "insert", value: note });
                        }
                        commit();
                        markReady();
                    },
                },
            }),
            applyAction: async () => {},
            runQueryFunction: async () => undefined,
        };
        const server = createRemoteOntologyServer<any, any>({
            ir: {
                ...ir,
                objectTypes: [noteObjectType],
            },
            backendAdapter,
            policy: {
                baseObjectTypeQueries: {
                    Note: ({ q, collection }: any) =>
                        q
                            .from({ object: collection })
                            .where(({ object }: any) =>
                                eq(object.ownerEmail, "alice@example.com")
                            ),
                },
                allowedObjectTypeProperties: {
                    Note: ["id", "ownerEmail", "status", "priority"],
                },
            } as any,
        });
        const response = await server.handleRequest(
            new Request("http://example.test/load-subset", {
                method: "POST",
                body: serializeRemoteOntologyJson({
                    objectType: "Note",
                    options: {
                        where: eq(new IR.PropRef(["status"]), "open"),
                        cursor: {
                            whereFrom: gt(new IR.PropRef(["priority"]), 1),
                            whereCurrent: eq(new IR.PropRef(["priority"]), 1),
                            lastKey: "one",
                        },
                        orderBy: [
                            {
                                expression: new IR.PropRef(["priority"]),
                                compareOptions: {
                                    direction: "asc",
                                    nulls: "last",
                                },
                            },
                        ],
                        offset: 1,
                        limit: 1,
                    },
                }),
            })
        );

        expect(response.status).toBe(200);
        expect(parseRemoteOntologyJson(await response.text())).toEqual({
            objectType: "Note",
            objects: [
                {
                    id: "three",
                    ownerEmail: "alice@example.com",
                    status: "open",
                    priority: 5,
                },
            ],
        });
    });

    it("starts on-demand collections for apply-action without hanging", async () => {
        let syncStarted = false;
        let cleanedUp = false;
        const onDemandIr: OntologyIR = {
            ...ir,
            objectTypes: [noteObjectType],
            actionTypes: [
                {
                    name: "createNote",
                    displayName: "Create note",
                    parameters: [
                        { name: "title", displayName: "Title", type: o.string({}) },
                        {
                            name: "note",
                            displayName: "Note",
                            type: o.objectReference({ objectType: "Note" }),
                        },
                    ],
                    logic: [
                        o.ActionLogicStep.createObject({
                            objectType: "Note",
                            values: [
                                {
                                    property: ["id"],
                                    value: o.Expression.literal({ value: "created" }),
                                },
                            ],
                        }),
                    ],
                },
            ],
        };
        const backendAdapter: OntologyBackendAdapter = {
            name: "test",
            getCollectionOptions: () => ({
                syncMode: "on-demand",
                sync: {
                    sync: ({ begin, write, commit, markReady }) => {
                        syncStarted = true;
                        begin({ immediate: true });
                        write({
                            type: "insert",
                            value: {
                                id: "note-1",
                                ownerEmail: "alice@example.com",
                                status: "open",
                                priority: 1,
                            },
                        });
                        commit();
                        queueMicrotask(() => markReady());
                        return {
                            loadSubset: () => true as const,
                            cleanup: () => {
                                cleanedUp = true;
                            },
                        };
                    },
                },
            }),
            applyAction: async () => {},
            runQueryFunction: async () => undefined,
        };
        const server = createRemoteOntologyServer<any, any>({
            ir: onDemandIr,
            backendAdapter,
            getContext: () => ({ user: { email: "alice@example.com" } }),
            policy: {
                canApplyAction: async (_ctx, request, { objects }) => {
                    const note = await queryOnce((q) =>
                        q
                            .from({ object: objects.Note! })
                            .where(({ object }) => eq((object as any).id, request.parameters.note))
                            .findOne()
                    );
                    return note != null;
                },
                baseObjectTypeQueries: {
                    Note: ({ q, collection }: { q: any; collection: any }) =>
                        q.from({ object: collection }),
                } as any,
            },
        });

        const response = await server.handleRequest(
            new Request("http://example.test/apply-action", {
                method: "POST",
                body: serializeRemoteOntologyJson({
                    actionType: "createNote",
                    parameters: {
                        title: "Hello",
                        note: "note-1",
                    },
                }),
            })
        );

        expect(response.status).toBe(200);
        expect(syncStarted).toBe(true);
        expect(cleanedUp).toBe(true);
        expect(parseRemoteOntologyJson(await response.text())).toMatchObject({
            invalidatedObjectTypes: ["Note"],
        });
    });

    it("cleans up on-demand collections after apply-action failure", async () => {
        let cleanedUp = false;
        const onDemandIr: OntologyIR = {
            ...ir,
            objectTypes: [noteObjectType],
        };
        const backendAdapter: OntologyBackendAdapter = {
            name: "test",
            getCollectionOptions: () => ({
                syncMode: "on-demand",
                sync: {
                    sync: ({ markReady }) => {
                        queueMicrotask(() => markReady());
                        return {
                            loadSubset: () => true as const,
                            cleanup: () => {
                                cleanedUp = true;
                            },
                        };
                    },
                },
            }),
            applyAction: async () => {
                throw new Error("backend failed");
            },
            runQueryFunction: async () => undefined,
        };
        const server = createRemoteOntologyServer<any, any>({
            ir: onDemandIr,
            backendAdapter,
            getContext: () => ({}),
            policy: {
                canApplyAction: () => true,
            },
        });

        const response = await server.handleRequest(
            new Request("http://example.test/apply-action", {
                method: "POST",
                body: serializeRemoteOntologyJson({
                    actionType: "createNote",
                    parameters: {
                        title: "Hello",
                        ownerEmail: "alice@example.com",
                        dueDate: "2026-06-15",
                    },
                }),
            })
        );

        expect(response.status).toBe(500);
        expect(cleanedUp).toBe(true);
    });
});
