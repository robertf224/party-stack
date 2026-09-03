import { NonRetryableError, o, type OntologyIR } from "@party-stack/ontology";
import { SalesforceApiError } from "@party-stack/salesforce-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    createSalesforceOntologyBackend,
    createSalesforceOntologyBackendAdapter,
} from "./createSalesforceOntologyBackendAdapter.js";

describe("createSalesforceOntologyBackendAdapter", () => {
    const ir: OntologyIR = {
        types: [],
        objectTypes: [
            {
                name: "Account",
                displayName: "Account",
                pluralDisplayName: "Accounts",
                primaryKey: "Id",
                properties: [
                    { name: "Id", displayName: "Id", type: o.string({}) },
                    { name: "Name", displayName: "Name", type: o.string({}) },
                ],
            },
        ],
        linkTypes: [],
        actionTypes: [
            {
                name: "Create_Account",
                displayName: "Create Account",
                parameters: [
                    {
                        name: "accountName",
                        displayName: "Account Name",
                        type: o.string({}),
                    },
                ],
                logic: [],
            },
        ],
        queryFunctionTypes: [],
    };

    // Preserve the Flow API name via the meta id convention at runtime.
    (ir.actionTypes[0] as { id?: string }).id = "salesforce:flow:Create_Account";

    const invokeFlowAction = vi.fn();
    const query = vi.fn();
    const queryMore = vi.fn();
    const invalidate = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
    });

    function createAdapter() {
        return createSalesforceOntologyBackendAdapter({
            ir,
            client: {
                instanceUrl: "https://example.my.salesforce.com",
                apiVersion: "61.0",
                tokenProvider: () => "token",
                fetch: vi.fn() as typeof fetch,
                connection: {} as never,
                request: vi.fn(),
                describeGlobal: vi.fn(),
                describeSObject: vi.fn(),
                query,
                queryMore,
                createRecord: vi.fn(),
                updateRecord: vi.fn(),
                deleteRecord: vi.fn(),
                subscribeToChangeEvents: vi.fn(),
                listFlowActions: vi.fn(),
                describeFlowAction: vi.fn(),
                invokeFlowAction,
            },
        });
    }

    it("invokes Flows by API name and invalidates collections on success", async () => {
        invokeFlowAction.mockResolvedValue([
            {
                isSuccess: true,
                outputValues: { Flow__InterviewStatus: "Finished" },
            },
        ]);
        const adapter = createAdapter();

        await adapter.applyAction(
            "Create_Account",
            { accountName: "Acme" },
            {
                objects: {
                    Account: {
                        utils: { invalidate },
                    } as never,
                },
            }
        );

        expect(invokeFlowAction).toHaveBeenCalledWith("Create_Account", [
            { accountName: "Acme" },
        ]);
        expect(invalidate).toHaveBeenCalledOnce();
    });

    it("maps validation failures to NonRetryableError", async () => {
        invokeFlowAction.mockRejectedValue(
            new SalesforceApiError("Required fields are missing", {
                statusCode: 400,
                errorCode: "REQUIRED_FIELD_MISSING",
            })
        );
        const adapter = createAdapter();

        await expect(
            adapter.applyAction("Create_Account", {}, { objects: {} })
        ).rejects.toBeInstanceOf(NonRetryableError);
    });

    it("maps unsuccessful Flow results to NonRetryableError", async () => {
        invokeFlowAction.mockResolvedValue([
            {
                isSuccess: false,
                errors: [{ message: "Flow failed validation" }],
            },
        ]);
        const adapter = createAdapter();

        await expect(
            adapter.applyAction("Create_Account", { accountName: "Acme" }, { objects: {} })
        ).rejects.toEqual(
            expect.objectContaining({
                name: "NonRetryableError",
                message: "Flow failed validation",
            })
        );
    });

    it("rejects query functions", async () => {
        const adapter = createAdapter();
        await expect(adapter.runQueryFunction("currentUser", {}, { objects: {} })).rejects.toThrow(
            /cannot run query function/
        );
    });

    it("creates a provider that builds adapters from a client factory", async () => {
        const provider = createSalesforceOntologyBackend({
            createClient: () =>
                ({
                    instanceUrl: "https://example.my.salesforce.com",
                    apiVersion: "61.0",
                    tokenProvider: () => "token",
                    fetch: vi.fn() as typeof fetch,
                    connection: {} as never,
                    request: vi.fn(),
                    describeGlobal: vi.fn(),
                    describeSObject: vi.fn(),
                    query,
                    queryMore,
                    createRecord: vi.fn(),
                    updateRecord: vi.fn(),
                    deleteRecord: vi.fn(),
                    subscribeToChangeEvents: vi.fn(),
                    listFlowActions: vi.fn(),
                    describeFlowAction: vi.fn(),
                    invokeFlowAction,
                }) as never,
        });

        const adapter = await provider(ir, {});
        expect(adapter.name).toBe("salesforce");
        expect(adapter.getCollectionOptions("Account").syncMode).toBe("on-demand");
    });
});
