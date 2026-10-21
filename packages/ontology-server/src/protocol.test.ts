import { o, type OntologyIR } from "@party-stack/ontology";
import { eq, gt, IR } from "@tanstack/db";
import { Effect } from "effect";
import { Temporal } from "temporal-polyfill";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createHttpRemoteOntologyTransport, createInProcessHttpRemoteOntologyTransport } from "./http.js";
import { parseRemoteOntologyRequest, serializeLoadSubsetOptions } from "./protocol.js";
import { createRemoteOntologyServer } from "./server.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("createHttpRemoteOntologyTransport", () => {
    it.each([
        { name: "record", headers: { authorization: "Bearer token", "Content-Type": "text/plain" } },
        {
            name: "Headers instance",
            headers: new Headers({ authorization: "Bearer token", "Content-Type": "text/plain" }),
        },
        {
            name: "header tuples",
            headers: [
                ["authorization", "Bearer token"],
                ["Content-Type", "text/plain"],
            ] as [string, string][],
        },
    ])("preserves $name headers for JSON and attachment requests", async ({ headers }) => {
        const requests: Request[] = [];
        const transport = createHttpRemoteOntologyTransport({
            url: "https://example.test/remote/",
            headers: () => headers,
            fetch: async (input, init) => {
                requests.push(new Request(input, init));
                return new Response("{}");
            },
        });

        await transport.describe();
        await transport.getAttachmentContent({ attachment: { id: "attachment-1" } });

        expect(requests).toHaveLength(2);
        for (const request of requests) {
            expect(request.headers.get("authorization")).toBe("Bearer token");
            expect(request.headers.get("content-type")).toBe("application/json");
        }
        expect(new Headers(headers).get("content-type")).toBe("text/plain");
    });

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
            const request = new Request(input, init);
            const endpoint = new URL(request.url).pathname.split("/").pop();
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
                applyActionBody = await request.json();
                return new Response(JSON.stringify({}));
            }
            if (endpoint === "validate-action") {
                validateActionBody = await request.json();
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
                if (new Request(input).url.endsWith("/describe")) {
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

    it("copies attachments into memory before building multipart requests in WebKit", async () => {
        vi.stubGlobal("navigator", {
            userAgent:
                "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) " +
                "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1",
        });
        const ir: OntologyIR = {
            types: [],
            objectTypes: [],
            linkTypes: [],
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
            queryFunctionTypes: [],
        };
        const originalFile = new File(["attachment contents"], "evidence.txt", {
            type: "text/plain",
        });
        const arrayBuffer = vi.spyOn(originalFile, "arrayBuffer");
        const fetchImpl: typeof fetch = async (_input, init) => {
            if (!(init?.body instanceof FormData)) throw new Error("Expected a multipart request");
            const uploadedFile = init.body.get("attachment:local-id");
            expect(uploadedFile).not.toBe(originalFile);
            expect(uploadedFile).toBeInstanceOf(File);
            if (!(uploadedFile instanceof File)) {
                throw new Error("Expected multipart attachment to be a File.");
            }
            expect(uploadedFile.name).toBe("evidence.txt");
            expect(uploadedFile.type).toBe("text/plain");
            await expect(uploadedFile.text()).resolves.toBe("attachment contents");
            return new Response(JSON.stringify({}));
        };
        const transport = createHttpRemoteOntologyTransport({
            url: "https://example.test/remote/",
            ir,
            fetch: fetchImpl,
        });

        await transport.applyAction(
            {
                actionType: "uploadDocument",
                parameters: {
                    file: { id: "local-id" },
                },
            },
            {
                attachments: [
                    {
                        attachment: { id: "local-id" },
                        blob: originalFile,
                    },
                ],
            }
        );

        expect(arrayBuffer).toHaveBeenCalledOnce();

        vi.stubGlobal("navigator", {
            userAgent:
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        });
        const chromiumFile = new File(["attachment contents"], "evidence.txt", {
            type: "text/plain",
        });
        const chromiumArrayBuffer = vi.spyOn(chromiumFile, "arrayBuffer");

        await transport.applyAction(
            {
                actionType: "uploadDocument",
                parameters: {
                    file: { id: "local-id" },
                },
            },
            {
                attachments: [
                    {
                        attachment: { id: "local-id" },
                        blob: chromiumFile,
                    },
                ],
            }
        );

        expect(chromiumArrayBuffer).not.toHaveBeenCalled();
    });

    it("preserves transport-safe load subset options", () => {
        const where = eq(new IR.PropRef(["status"]), "open");
        const whereFrom = gt(new IR.PropRef(["priority"]), 5);
        const whereCurrent = eq(new IR.PropRef(["priority"]), 5);
        const signal = new AbortController().signal;
        const options = serializeLoadSubsetOptions({
            where,
            cursor: {
                whereFrom,
                whereCurrent,
                lastKey: "task-5",
            },
            offset: 2,
            limit: 3,
            signal,
            subscription: {} as never,
        });
        const request = parseRemoteOntologyRequest("load-subset", {
            objectType: "Task",
            options,
        });

        expect(options).not.toHaveProperty("signal");
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

describe("createInProcessHttpRemoteOntologyTransport", () => {
    it("routes requests through the HTTP server adapter", async () => {
        const ir: OntologyIR = {
            types: [],
            objectTypes: [],
            linkTypes: [],
            actionTypes: [
                {
                    name: "createNote",
                    displayName: "Create note",
                    parameters: [
                        {
                            name: "title",
                            displayName: "Title",
                            type: o.string({}),
                        },
                        {
                            name: "ownerEmail",
                            displayName: "Owner",
                            type: o.string({}),
                        },
                    ],
                    logic: [],
                },
            ],
            queryFunctionTypes: [],
        };
        const server = createRemoteOntologyServer<any, any>({
            ir,
            backendAdapter: {
                name: "test",
                open: () =>
                    Effect.succeed({
                        name: "test",
                        sourceId: "test",
                        supportsIdempotency: false,
                        loadSubset: () => Effect.succeed({ rows: [], complete: true }),
                        invoke: (action) =>
                            Effect.succeed({ invocationId: action.id, outcome: "committed", affected: [] }),
                        queryFunction: () => Effect.void,
                    }),
            },
            getContext: () => ({
                user: {
                    email: "alice@example.com",
                },
            }),
            policy: {
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
        const transport = createInProcessHttpRemoteOntologyTransport(server);

        await transport.describe();
        await expect(
            transport.resolveActionParameters({
                actionType: "createNote",
                parameters: {
                    title: "Hello",
                    ownerEmail: "mallory@example.com",
                },
            })
        ).resolves.toEqual({
            parameters: {
                title: "Hello",
            },
        });
    });
});
