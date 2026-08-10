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
