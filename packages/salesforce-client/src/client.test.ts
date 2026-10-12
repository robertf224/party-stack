import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createSalesforceClient } from "./client.js";
import { SalesforceApiError } from "./errors.js";

afterEach(() => {
    vi.restoreAllMocks();
});

function urlString(input: RequestInfo | URL): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    return input.url;
}

describe("createSalesforceClient", () => {
    it("normalizes instance URL and API version", () => {
        const client = createSalesforceClient({
            instanceUrl: "https://example.my.salesforce.com/",
            apiVersion: "v61.0",
            tokenProvider: () => "token",
            fetch: vi.fn(),
        });

        expect(client.instanceUrl).toBe("https://example.my.salesforce.com");
        expect(client.apiVersion).toBe("61.0");
    });

    it("supports installation-provided authenticated fetch", async () => {
        const fetchMock = vi.fn(() =>
            Promise.resolve(
                Response.json({
                    encoding: "UTF-8",
                    maxBatchSize: 200,
                    sobjects: [],
                })
            )
        );
        const client = createSalesforceClient({
            instanceUrl: "https://example.my.salesforce.com",
            apiVersion: "61.0",
            authenticatedFetch: true,
            fetch: fetchMock,
        });

        await expect(client.describeGlobal()).resolves.toMatchObject({
            sobjects: [],
        });
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("attaches bearer auth and queries SOQL", async () => {
        const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            const url = urlString(input);
            expect(url).toContain("/services/data/v61.0/query?q=");
            expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain("SELECT Id FROM Account");
            expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret-token");
            return Promise.resolve(
                new Response(
                    JSON.stringify({
                        totalSize: 1,
                        done: true,
                        records: [{ Id: "001xx000003DGb2AAG" }],
                    }),
                    { status: 200, headers: { "Content-Type": "application/json" } }
                )
            );
        });

        const client = createSalesforceClient({
            instanceUrl: "https://example.my.salesforce.com",
            apiVersion: "61.0",
            tokenProvider: () => Promise.resolve("secret-token"),
            fetch: fetchMock,
        });

        await expect(client.query("SELECT Id FROM Account")).resolves.toEqual({
            totalSize: 1,
            done: true,
            records: [{ Id: "001xx000003DGb2AAG" }],
        });
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("follows relative nextRecordsUrl paths for pagination", async () => {
        const fetchMock = vi.fn((input: RequestInfo | URL) => {
            const url = urlString(input);
            expect(url).toBe("https://example.my.salesforce.com/services/data/v61.0/query/01gXX-2000");
            return Promise.resolve(
                new Response(
                    JSON.stringify({
                        totalSize: 2,
                        done: true,
                        records: [{ Id: "001xx000003DGb3AAG" }],
                    }),
                    { status: 200, headers: { "Content-Type": "application/json" } }
                )
            );
        });

        const client = createSalesforceClient({
            instanceUrl: "https://example.my.salesforce.com",
            apiVersion: "61.0",
            tokenProvider: () => "token",
            fetch: fetchMock,
        });

        await expect(client.queryMore("/services/data/v61.0/query/01gXX-2000")).resolves.toMatchObject({
            done: true,
            records: [{ Id: "001xx000003DGb3AAG" }],
        });
    });

    it("normalizes Salesforce REST errors", async () => {
        const fetchMock = vi.fn(() =>
            Promise.resolve(
                new Response(
                    JSON.stringify([
                        {
                            message: "INVALID_FIELD: No such column",
                            errorCode: "INVALID_FIELD",
                        },
                    ]),
                    { status: 400, headers: { "Content-Type": "application/json" } }
                )
            )
        );

        const client = createSalesforceClient({
            instanceUrl: "https://example.my.salesforce.com",
            apiVersion: "61.0",
            tokenProvider: () => "token",
            fetch: fetchMock,
        });

        await expect(client.describeSObject("Account")).rejects.toEqual(
            expect.objectContaining({
                name: "SalesforceApiError",
                statusCode: 400,
                errorCode: "INVALID_FIELD",
                message: "INVALID_FIELD: No such column",
            })
        );
        expect(SalesforceApiError).toBeDefined();
    });

    it("creates, updates, and deletes Salesforce records", async () => {
        const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            expect(headers.get("Authorization")).toBe("Bearer token");
            expect(headers.has("Content-Length")).toBe(false);
            void input;
            if (init?.method === "POST") {
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            id: "00TPW0000012345YAA",
                            success: true,
                            errors: [],
                        }),
                        { status: 201, headers: { "Content-Type": "application/json" } }
                    )
                );
            }
            if (init?.method === "PATCH") {
                return Promise.resolve(new Response(null, { status: 204 }));
            }
            if (init?.method === "DELETE") {
                return Promise.resolve(new Response(null, { status: 204 }));
            }
            return Promise.reject(new Error(`Unexpected method ${init?.method}`));
        });

        const client = createSalesforceClient({
            instanceUrl: "https://example.my.salesforce.com",
            apiVersion: "61.0",
            tokenProvider: () => "token",
            fetch: fetchMock,
        });

        await expect(
            client.createRecord("Task", {
                Subject: "Party Stack demo",
                Status: "Not Started",
            })
        ).resolves.toMatchObject({ id: "00TPW0000012345YAA", success: true });
        await expect(
            client.updateRecord("Task", "00TPW0000012345YAA", {
                Subject: "Updated demo",
            })
        ).resolves.toMatchObject({ id: "00TPW0000012345YAA", success: true });
        await expect(client.deleteRecord("Task", "00TPW0000012345YAA")).resolves.toMatchObject({
            id: "00TPW0000012345YAA",
            success: true,
        });
        expect(fetchMock).toHaveBeenCalledTimes(3);
        const [created, updated, deleted] = fetchMock.mock.calls.map(
            ([input, init]) => new Request(input, init)
        );
        expect(created!.url).toBe("https://example.my.salesforce.com/services/data/v61.0/sobjects/Task");
        expect(created!.method).toBe("POST");
        expect(await created!.json()).toEqual({ Subject: "Party Stack demo", Status: "Not Started" });
        expect(updated!.url).toBe(
            "https://example.my.salesforce.com/services/data/v61.0/sobjects/Task/00TPW0000012345YAA"
        );
        expect(updated!.method).toBe("PATCH");
        expect(await updated!.json()).toEqual({ Subject: "Updated demo" });
        expect(deleted!.url).toBe(updated!.url);
        expect(deleted!.method).toBe("DELETE");
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("subscribes to Salesforce Change Data Capture channels", async () => {
        const event = {
            event: { replayId: 42 },
            payload: {
                ChangeEventHeader: {
                    entityName: "Task",
                    changeType: "UPDATE",
                    recordIds: ["00TPW0000012345YAA"],
                },
            },
        };
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                Response.json([
                    {
                        channel: "/meta/handshake",
                        successful: true,
                        clientId: "client-1",
                    },
                ])
            )
            .mockResolvedValueOnce(
                Response.json([
                    {
                        channel: "/meta/subscribe",
                        successful: true,
                    },
                ])
            )
            .mockResolvedValueOnce(
                Response.json([
                    {
                        channel: "/data/TaskChangeEvent",
                        data: event,
                    },
                    {
                        channel: "/meta/connect",
                        successful: true,
                    },
                ])
            )
            .mockImplementation(
                (...args: [RequestInfo | URL, RequestInit?]) =>
                    new Promise<Response>((resolve, reject) => {
                        void resolve;
                        const init = args[1];
                        init?.signal?.addEventListener(
                            "abort",
                            () => reject(new DOMException("Aborted", "AbortError")),
                            { once: true }
                        );
                    })
            );
        const client = createSalesforceClient({
            instanceUrl: "https://example.my.salesforce.com",
            apiVersion: "61.0",
            tokenProvider: () => "stream-token",
            fetch: fetchMock as typeof fetch,
        });
        const listener = vi.fn();

        const subscription = await client.subscribeToChangeEvents("Task", listener, { replayId: 41 });
        await vi.waitFor(() => {
            expect(listener).toHaveBeenCalledWith(event);
        });
        subscription.unsubscribe();

        const handshakeCall = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit?];
        const subscribeCall = fetchMock.mock.calls[1] as unknown as [RequestInfo | URL, RequestInit?];
        expect(urlString(handshakeCall[0])).toBe("https://example.my.salesforce.com/cometd/61.0");
        expect(handshakeCall[1]?.credentials).toBe("include");
        const subscribeBody = subscribeCall[1]?.body;
        expect(typeof subscribeBody === "string" ? JSON.parse(subscribeBody) : undefined).toMatchObject([
            {
                subscription: "/data/TaskChangeEvent",
                ext: {
                    replay: {
                        "/data/TaskChangeEvent": 41,
                    },
                },
            },
        ]);
        expect(subscription.channel).toBe("/data/TaskChangeEvent");
    });

    it("invokes Flow actions with an inputs payload", async () => {
        const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            expect(urlString(input)).toBe(
                "https://example.my.salesforce.com/services/data/v61.0/actions/custom/flow/Create_Account"
            );
            expect(init?.method).toBe("POST");
            const body = typeof init?.body === "string" ? init.body : "";
            expect(JSON.parse(body)).toEqual({
                inputs: [{ Name: "Acme" }],
            });
            return Promise.resolve(
                new Response(
                    JSON.stringify([
                        {
                            actionName: "Create_Account",
                            isSuccess: true,
                            outputValues: { Flow__InterviewStatus: "Finished" },
                        },
                    ]),
                    { status: 200, headers: { "Content-Type": "application/json" } }
                )
            );
        });

        const client = createSalesforceClient({
            instanceUrl: "https://example.my.salesforce.com",
            apiVersion: "61.0",
            tokenProvider: () => "token",
            fetch: fetchMock,
        });

        await expect(client.invokeFlowAction("Create_Account", [{ Name: "Acme" }])).resolves.toEqual([
            {
                actionName: "Create_Account",
                isSuccess: true,
                outputValues: { Flow__InterviewStatus: "Finished" },
            },
        ]);
    });

    it("describes and invokes standard actions", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        name: "getAvailableMeetingTimes",
                        inputs: [],
                        outputs: [],
                    }),
                    {
                        status: 200,
                        headers: {
                            "Content-Type": "application/json",
                        },
                    }
                )
            )
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify([
                        {
                            actionName: "getAvailableMeetingTimes",
                            isSuccess: true,
                            outputValues: {},
                        },
                    ]),
                    {
                        status: 200,
                        headers: {
                            "Content-Type": "application/json",
                        },
                    }
                )
            );
        const client = createSalesforceClient({
            instanceUrl: "https://example.my.salesforce.com",
            apiVersion: "61.0",
            tokenProvider: () => "token",
            fetch: fetchMock as typeof fetch,
        });

        await client.describeStandardAction("getAvailableMeetingTimes");
        await client.invokeStandardAction("getAvailableMeetingTimes", [{}]);

        const describeCall = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit?];
        const invokeCall = fetchMock.mock.calls[1] as unknown as [RequestInfo | URL, RequestInit?];
        expect(urlString(describeCall[0])).toBe(
            "https://example.my.salesforce.com/services/data/v61.0/actions/standard/getAvailableMeetingTimes"
        );
        expect(urlString(invokeCall[0])).toBe(
            "https://example.my.salesforce.com/services/data/v61.0/actions/standard/getAvailableMeetingTimes"
        );
        expect(invokeCall[1]?.method).toBe("POST");
    });

    it("batches action describes through the Composite Batch API", async () => {
        let compositeBody = "";
        const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            expect(urlString(input)).toBe(
                "https://example.my.salesforce.com/services/data/v61.0/composite/batch"
            );
            if (typeof init?.body !== "string") {
                throw new Error("Expected a JSON Composite request body.");
            }
            compositeBody = init.body;
            return Promise.resolve(
                Response.json({
                    hasErrors: false,
                    results: [
                        {
                            result: {
                                name: "First_Flow",
                                inputs: [],
                            },
                            statusCode: 200,
                        },
                        {
                            result: {
                                name: "Second_Flow",
                                inputs: [],
                            },
                            statusCode: 200,
                        },
                    ],
                })
            );
        });
        const client = createSalesforceClient({
            instanceUrl: "https://example.my.salesforce.com",
            apiVersion: "61.0",
            tokenProvider: () => "token",
            fetch: fetchMock,
        });

        await expect(
            client.describeInvocableActions([
                {
                    kind: "flow",
                    apiName: "First_Flow",
                },
                {
                    kind: "standard",
                    apiName: "Second_Action",
                },
            ])
        ).resolves.toMatchObject([{ name: "First_Flow" }, { name: "Second_Flow" }]);
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(compositeBody).toContain("v61.0/actions/custom/flow/First_Flow");
        expect(compositeBody).toContain("v61.0/actions/standard/Second_Action");
    });
});
