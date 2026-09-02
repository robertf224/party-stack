import { afterEach, describe, expect, it, vi } from "vitest";
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
            instanceUrl:
                "https://example.my.salesforce.com",
            apiVersion: "61.0",
            authenticatedFetch: true,
            fetch: fetchMock as typeof fetch,
        });

        await expect(
            client.describeGlobal()
        ).resolves.toMatchObject({
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
            fetch: fetchMock as typeof fetch,
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
            expect(url).toBe(
                "https://example.my.salesforce.com/services/data/v61.0/query/01gXX-2000"
            );
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
            fetch: fetchMock as typeof fetch,
        });

        await expect(
            client.queryMore("/services/data/v61.0/query/01gXX-2000")
        ).resolves.toMatchObject({ done: true, records: [{ Id: "001xx000003DGb3AAG" }] });
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
            fetch: fetchMock as typeof fetch,
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
            const url = urlString(input);
            if (init?.method === "POST") {
                expect(url).toBe(
                    "https://example.my.salesforce.com/services/data/v61.0/sobjects/Task"
                );
                const body = typeof init.body === "string" ? init.body : "";
                expect(JSON.parse(body)).toEqual({
                    Subject: "Party Stack demo",
                    Status: "Not Started",
                });
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
                expect(url).toBe(
                    "https://example.my.salesforce.com/services/data/v61.0/sobjects/Task/00TPW0000012345YAA"
                );
                const body = typeof init.body === "string" ? init.body : "";
                expect(JSON.parse(body)).toEqual({
                    Subject: "Updated demo",
                });
                return Promise.resolve(new Response(null, { status: 204 }));
            }
            if (init?.method === "DELETE") {
                expect(url).toBe(
                    "https://example.my.salesforce.com/services/data/v61.0/sobjects/Task/00TPW0000012345YAA"
                );
                return Promise.resolve(new Response(null, { status: 204 }));
            }
            return Promise.reject(new Error(`Unexpected method ${init?.method}`));
        });

        const client = createSalesforceClient({
            instanceUrl: "https://example.my.salesforce.com",
            apiVersion: "61.0",
            tokenProvider: () => "token",
            fetch: fetchMock as typeof fetch,
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
        await expect(
            client.deleteRecord("Task", "00TPW0000012345YAA")
        ).resolves.toMatchObject({ id: "00TPW0000012345YAA", success: true });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("subscribes to Salesforce Change Data Capture channels", async () => {
        const client = createSalesforceClient({
            instanceUrl: "https://example.my.salesforce.com",
            apiVersion: "61.0",
            tokenProvider: () => "stream-token",
            fetch: vi.fn(),
        });
        const cancel = vi.fn();
        let receive: ((event: unknown) => void) | undefined;
        const subscribe = vi
            .spyOn(client.connection.streaming, "subscribe")
            .mockImplementation((channel, listener) => {
                expect(channel).toBe("/data/TaskChangeEvent");
                receive = listener as (event: unknown) => void;
                return Object.assign(Promise.resolve(), {
                    cancel,
                    unsubscribe: cancel,
                    withChannel: vi.fn(),
                }) as never;
            });
        const listener = vi.fn();

        const subscription = await client.subscribeToChangeEvents("Task", listener);
        const event = {
            payload: {
                ChangeEventHeader: {
                    entityName: "Task",
                    changeType: "UPDATE",
                    recordIds: ["00TPW0000012345YAA"],
                },
            },
        };
        receive?.(event);
        subscription.unsubscribe();

        expect(client.connection.accessToken).toBe("stream-token");
        expect(subscribe).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledWith(event);
        expect(subscription.channel).toBe("/data/TaskChangeEvent");
        expect(cancel).toHaveBeenCalledOnce();
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
            fetch: fetchMock as typeof fetch,
        });

        await expect(
            client.invokeFlowAction("Create_Account", [{ Name: "Acme" }])
        ).resolves.toEqual([
            {
                actionName: "Create_Account",
                isSuccess: true,
                outputValues: { Flow__InterviewStatus: "Finished" },
            },
        ]);
    });
});
