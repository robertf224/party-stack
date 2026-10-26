import { o, type OntologyBackendAdapter, type OntologyIR } from "@party-stack/ontology";
import { BackendError, type OntologyBackendService } from "@party-stack/ontology-backend";
import { eq, gt, IR, queryOnce } from "@tanstack/db";
import { Effect } from "effect";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vite-plus/test";
import { createInProcessHttpRemoteOntologyTransport } from "./http.js";
import { parseRemoteOntologyJson, serializeRemoteOntologyJson } from "./protocol.js";
import { createRemoteOntologyServer } from "./server.js";
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
            parameters: [{ name: "title", displayName: "Title", type: o.string({}) }],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "Note",
                    values: [
                        {
                            property: ["ownerEmail"],
                            value: o.Expression.getAt({
                                source: o.Expression.contextReference({
                                    name: "user",
                                }),
                                path: ["email"],
                            }),
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

describe("remote ontology server policy projection", () => {
    it("describes the secured IR and applies server-owned action parameters last", async () => {
        let appliedParameters: Record<string, unknown> | undefined;
        let validatedParameters: Record<string, unknown> | undefined;
        const backendAdapter: OntologyBackendAdapter = testBinding({
            name: "test",

            validateAction: (_actionType, parameters) =>
                Effect.sync(() => {
                    validatedParameters = parameters;
                    return {
                        certain: true,
                        value: {
                            kind: "ok",
                            value: undefined,
                        },
                    } as const;
                }),

            rows: [],
            apply: async (_actionType, parameters) => {
                appliedParameters = parameters;
            },
            query: async (_queryFunctionType, parameters) => {
                if (typeof parameters.name !== "string") throw new Error("Expected a string name");
                return `Hello ${parameters.name}`;
            },
        });
        const server = createRemoteOntologyServer<any, any>({
            ir,
            backendAdapter,
            getContext: () => ({ user: { email: "alice@example.com" } }),
            policy: {
                canApplyAction: () => true,
                fixedActionParameterValues: {
                    createNote: {
                        ownerEmail: o.Expression.getAt({
                            source: o.Expression.contextReference({
                                name: "user",
                            }),
                            path: ["email"],
                        }),
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
        const description = parseRemoteOntologyJson(
            await describeResponse.text()
        ) as RemoteOntologyDescription;
        expect(description.capabilities).toEqual({
            journal: false,
            actionValidation: true,
            actionParameterResolution: true,
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

        const resolveResponse = await server.handleRequest(
            new Request("http://example.test/resolve-action-parameters", {
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
        expect(resolveResponse.status, await resolveResponse.clone().text()).toBe(200);
        expect(parseRemoteOntologyJson(await resolveResponse.text())).toEqual({
            parameters: {
                title: "Hello",
            },
        });
    });

    it("resolves defaults from fixed object references without exposing blocked properties", async () => {
        const employeeReference = o.Expression.inputReference({
            name: "employee",
        });
        const employeeObject = o.Expression.objectLookup({
            reference: employeeReference,
        });
        const securedIr: OntologyIR = {
            ...ir,
            objectTypes: [
                {
                    name: "Employee",
                    displayName: "Employee",
                    pluralDisplayName: "Employees",
                    primaryKey: "id",
                    properties: [
                        {
                            name: "id",
                            displayName: "ID",
                            type: o.string({}),
                        },
                        {
                            name: "title",
                            displayName: "Title",
                            type: o.string({}),
                        },
                        {
                            name: "secret",
                            displayName: "Secret",
                            type: o.string({}),
                        },
                    ],
                },
            ],
            actionTypes: [
                {
                    name: "editEmployee",
                    displayName: "Edit employee",
                    parameters: [
                        {
                            name: "employee",
                            displayName: "Employee",
                            type: o.objectReference({
                                objectType: "Employee",
                            }),
                        },
                        {
                            name: "title",
                            displayName: "Title",
                            type: o.string({}),
                            defaultValue: o.Expression.getAt({
                                source: employeeObject,
                                path: ["title"],
                            }),
                        },
                        {
                            name: "secret",
                            displayName: "Secret",
                            type: o.string({}),
                            defaultValue: o.Expression.getAt({
                                source: employeeObject,
                                path: ["secret"],
                            }),
                        },
                    ],
                    logic: [],
                },
            ],
        };
        const server = createRemoteOntologyServer<any, any>({
            ir: securedIr,
            backendAdapter: testBinding({
                name: "test",

                rows: [
                    {
                        id: "employee-1",
                        title: "Visible title",
                        secret: "hidden value",
                    },
                ],
                apply: async () => {},
                query: async () => undefined,
            }),
            policy: {
                fixedActionParameterValues: {
                    editEmployee: {
                        employee: o.Expression.literal({
                            value: "employee-1",
                        }),
                    },
                },
                baseObjectTypeQueries: {
                    Employee: ({ q, collection }: any) =>
                        q.from({
                            object: collection,
                        }),
                },
                allowedObjectTypeProperties: {
                    Employee: ["id", "title"],
                },
            } as any,
        });

        const describeResponse = await server.handleRequest(
            new Request("http://example.test/describe", {
                method: "POST",
                body: serializeRemoteOntologyJson({}),
            })
        );
        const description = parseRemoteOntologyJson(
            await describeResponse.text()
        ) as RemoteOntologyDescription;
        expect(description.ir.actionTypes[0]!.parameters.map((parameter) => parameter.name)).toEqual([
            "title",
            "secret",
        ]);
        expect(description.ir.actionTypes[0]!.parameters[0]?.defaultValue).toBeUndefined();

        const resolveResponse = await server.handleRequest(
            new Request("http://example.test/resolve-action-parameters", {
                method: "POST",
                body: serializeRemoteOntologyJson({
                    actionType: "editEmployee",
                    parameters: {},
                }),
            })
        );

        expect(resolveResponse.status, await resolveResponse.clone().text()).toBe(200);
        expect(parseRemoteOntologyJson(await resolveResponse.text())).toEqual({
            parameters: {
                title: "Visible title",
            },
        });
    });

    it("includes forwarded context in describe and preserves context references", async () => {
        const server = createRemoteOntologyServer<any, any>({
            ir: {
                ...ir,
                objectTypes: [noteObjectType],
            },
            backendAdapter: testBinding({
                name: "test",

                rows: [],
                apply: async () => {},
                query: async () => undefined,
            }),
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
                value: o.Expression.getAt({
                    source: o.Expression.contextReference({
                        name: "user",
                    }),
                    path: ["email"],
                }),
            },
        ]);
    });

    it("returns projected context without preserving source context references", async () => {
        const server = createRemoteOntologyServer<any, any>({
            ir: {
                ...ir,
                objectTypes: [noteObjectType],
            },
            backendAdapter: testBinding({
                name: "test",

                rows: [],
                apply: async () => {},
                query: async () => undefined,
            }),
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
            backendAdapter: testBinding({
                name: "test",

                rows: [],
                apply: async () => {},
                query: async (_queryFunctionType, parameters) => {
                    if (typeof parameters.name !== "string") throw new Error("Expected a string name");
                    return `Hello ${parameters.name}`;
                },
            }),
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
        const backendAdapter: OntologyBackendAdapter = testBinding({
            name: "test",

            rows: notes,
            apply: async () => {},
            query: async () => undefined,
        });
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
                            .where(({ object }: any) => eq(object.ownerEmail, "alice@example.com")),
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

    it("stages multipart files before materializing opaque attachment IDs", async () => {
        const localId = "opaque-local-id";
        const remoteId = "ri.attachments.main.attachment.remote";
        const uploadIr: OntologyIR = {
            ...ir,
            actionTypes: [
                {
                    name: "uploadDocument",
                    displayName: "Upload document",
                    parameters: [
                        {
                            name: "file",
                            displayName: "File",
                            type: o.attachment({}),
                        },
                    ],
                    logic: [],
                },
            ],
        };
        let appliedParameters: Record<string, unknown> | undefined;
        let materializedFile: Blob | undefined;
        const server = createRemoteOntologyServer<any, any>({
            ir: uploadIr,
            backendAdapter: testBinding({
                name: "test",

                attachments: {
                    materializeAttachment: async (attachment, blob) => {
                        materializedFile = blob;
                        return {
                            ...attachment,
                            id: remoteId,
                        };
                    },
                    getAttachmentContent: () =>
                        Promise.reject(new Error("unexpected remote attachment read")),
                },

                rows: [],
                apply: async (_actionType, parameters) => {
                    appliedParameters = parameters;
                },
                query: async () => undefined,
            }),
            policy: {
                canApplyAction: () => true,
            },
        });
        const transport = createInProcessHttpRemoteOntologyTransport(server, {
            ir: uploadIr,
        });
        const file = new File(["attachment contents"], "evidence.txt", {
            type: "text/plain",
        });

        const response = await transport.applyAction(
            {
                actionType: "uploadDocument",
                parameters: {
                    file: { id: localId },
                },
            },
            {
                attachments: [
                    {
                        attachment: { id: localId },
                        blob: file,
                    },
                ],
            }
        );

        expect(materializedFile).toBeInstanceOf(File);
        expect((materializedFile as File).name).toBe("evidence.txt");
        expect(materializedFile?.type).toBe("text/plain");
        await expect(materializedFile?.text()).resolves.toBe("attachment contents");
        expect(appliedParameters).toEqual({
            file: { id: remoteId },
        });
        expect(response.attachmentIdMappings).toEqual([
            {
                localId,
                remoteId,
            },
        ]);
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
        const backendAdapter: OntologyBackendAdapter = testBinding({
            name: "test",

            rows: [
                {
                    id: "note-1",
                    ownerEmail: "alice@example.com",
                    status: "open",
                    priority: 1,
                },
            ],
            apply: async () => {},
            query: async () => undefined,
            onRead: () => {
                syncStarted = true;
            },
            onClose: () => {
                cleanedUp = true;
            },
        });
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
                    Note: ({ q, collection }: { q: any; collection: any }) => q.from({ object: collection }),
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
        const backendAdapter: OntologyBackendAdapter = testBinding({
            name: "test",

            rows: [],
            apply: async () => {
                throw new Error("backend failed");
            },
            query: async () => undefined,
            onClose: () => {
                cleanedUp = true;
            },
        });
        const server = createRemoteOntologyServer<any, any>({
            ir: onDemandIr,
            backendAdapter,
            getContext: () => ({}),
            policy: {
                canApplyAction: async (_ctx, _request, { objects }) => {
                    await queryOnce((q) =>
                        q
                            .from({ note: objects.Note! })
                            .where(({ note }) => eq((note as any).id, "note-1"))
                            .findOne()
                    );
                    return true;
                },
                baseObjectTypeQueries: {
                    Note: ({ q, collection }: { q: any; collection: any }) => q.from({ object: collection }),
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
                        ownerEmail: "alice@example.com",
                        dueDate: "2026-06-15",
                    },
                }),
            })
        );

        expect(response.status).toBe(422);
        expect(cleanedUp).toBe(true);
    });
});

describe("authorized replica protocol", () => {
    it("denies by default, checks revocation, and keeps coordinated cursors and Temporal values", async () => {
        let granted = false;
        let reads = 0;
        let released = 0;
        const date = Temporal.PlainDate.from("2026-10-19");
        const replicaIR = {
            ...ir,
            objectTypes: [
                {
                    ...noteObjectType,
                    properties: [
                        ...noteObjectType.properties,
                        { name: "due", displayName: "Due", type: o.date({}) },
                    ],
                },
            ],
        };
        const value = { id: "n", ownerEmail: "alice", status: "open", priority: 1, due: date };
        const adapter: OntologyBackendAdapter = {
            name: "replica",

            open: () =>
                Effect.succeed<OntologyBackendService>({
                    name: "owned",
                    sourceId: "source",
                    supportsIdempotency: true,
                    loadSubset: () =>
                        Effect.sync(() => {
                            reads++;
                            return { rows: [{ key: "n", value }], complete: true, cursor: "source:2" };
                        }),
                    invoke: () =>
                        Effect.fail(
                            new BackendError({
                                operation: "invoke",
                                kind: "NotImplemented",
                                message: "No actions",
                                retryable: false,
                            })
                        ),
                    queryFunction: () => Effect.void,
                    changes: {
                        pull: ({ cursor }) =>
                            cursor === "invalid"
                                ? Effect.fail(
                                      new BackendError({
                                          operation: "pull",
                                          kind: "HistoryExpired",
                                          message: "Invalid source",
                                          retryable: false,
                                      })
                                  )
                                : Effect.succeed({
                                      commits: [
                                          {
                                              cursor: "source:2",
                                              invocationId: "a",
                                              changes: [{ kind: "put", objectType: "Note", key: "n", value }],
                                          },
                                      ],
                                      cursor: "source:2",
                                      hasMore: false,
                                  }),
                    },
                }).pipe(
                    Effect.tap(() =>
                        Effect.addFinalizer(() =>
                            Effect.sync(() => {
                                released++;
                            })
                        )
                    )
                ),
        };
        const server = createRemoteOntologyServer({
            ir: replicaIR,
            backendAdapter: adapter,
            policy: { authorizeFullReplica: () => granted },
        });
        const transport = createInProcessHttpRemoteOntologyTransport(server, { ir: replicaIR });
        await expect(transport.replicaSnapshot!({ objectType: "Note" })).rejects.toMatchObject({
            status: 403,
        });
        await expect(transport.pullChanges!({})).rejects.toMatchObject({ status: 403 });
        expect(reads).toBe(0);
        granted = true;
        expect((await transport.describe()).capabilities?.journal).toBe(true);
        const snapshot = await transport.replicaSnapshot!({ objectType: "Note" });
        expect(released).toBe(1);
        expect(snapshot.cursor).toBe("source:2");
        expect(snapshot.rows[0]?.value.due).toEqual(date);
        const page = await transport.pullChanges!({});
        expect(page.commits[0]?.changes[0]).toMatchObject({ kind: "put", value: { due: date } });
        await expect(transport.pullChanges!({ cursor: "invalid" })).rejects.toMatchObject({
            name: "HistoryExpired",
            status: 409,
            retryable: false,
        });
        expect(released).toBe(3);
        granted = false;
        await expect(transport.pullChanges!({ cursor: page.cursor })).rejects.toMatchObject({ status: 403 });
        const defaultServer = createRemoteOntologyServer({ ir: replicaIR, backendAdapter: adapter });
        const denied = createInProcessHttpRemoteOntologyTransport(defaultServer, { ir: replicaIR });
        await expect(denied.pullChanges!({})).rejects.toMatchObject({ status: 403 });
    });
});

function testBinding(
    options: Omit<Partial<OntologyBackendAdapter>, "open"> & {
        rows?: readonly Record<string, unknown>[];
        apply?: (name: string, parameters: Record<string, unknown>) => Promise<unknown>;
        query?: (name: string, parameters: Record<string, unknown>) => Promise<unknown>;
        onRead?: () => void;
        onClose?: () => void;
    }
): OntologyBackendAdapter {
    const attempt = <A>(run: () => Promise<A>) =>
        Effect.tryPromise({
            try: run,
            catch: (cause) =>
                new BackendError({
                    operation: "test",
                    kind: "ValidationFailed",
                    retryable: false,
                    message: cause instanceof Error ? cause.message : String(cause),
                    cause,
                }),
        });
    return {
        name: options.name ?? "test",
        validateAction: options.validateAction,
        attachments: options.attachments,
        open: () =>
            Effect.acquireRelease(
                Effect.succeed<OntologyBackendService>({
                    name: "test",
                    sourceId: "test",
                    supportsIdempotency: false,
                    loadSubset: () =>
                        Effect.sync(() => {
                            options.onRead?.();
                            return {
                                complete: true,
                                rows: (options.rows ?? []).map((value) => ({
                                    key: value.id as string,
                                    value,
                                })),
                            };
                        }),
                    invoke: (invocation) =>
                        Effect.as(
                            attempt(async () => options.apply?.(invocation.name, invocation.parameters)),
                            { invocationId: invocation.id, outcome: "committed" as const, affected: [] }
                        ),
                    queryFunction: (name, parameters) =>
                        attempt(async () => options.query?.(name, parameters)),
                }),
                () => Effect.sync(() => options.onClose?.())
            ),
    };
}
