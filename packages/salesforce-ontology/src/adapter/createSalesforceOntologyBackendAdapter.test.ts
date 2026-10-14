import { NonRetryableError, o, type OntologyIR } from "@party-stack/ontology";
import { SalesforceApiError } from "@party-stack/salesforce-client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
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
                meta: { salesforce: { kind: "flow", apiName: "Create_Account" } },
                name: "Create_Account",
                displayName: "Create Account",
                parameters: [{ name: "accountName", displayName: "Account Name", type: o.string({}) }],
                logic: [],
            },
            {
                meta: { salesforce: { kind: "crud", objectType: "Account", operation: "create" } },
                name: "createAccount",
                displayName: "Create Account",
                parameters: [{ name: "Name", displayName: "Name", type: o.string({}) }],
                logic: [],
            },
            {
                meta: { salesforce: { kind: "crud", objectType: "Account", operation: "update" } },
                name: "updateAccount",
                displayName: "Update Account",
                parameters: [
                    {
                        name: "recordId",
                        displayName: "Account ID",
                        type: o.objectReference({ objectType: "Account" }),
                    },
                    { name: "Name", displayName: "Name", type: o.optional({ type: o.string({}) }) },
                ],
                logic: [],
            },
            {
                meta: { salesforce: { kind: "crud", objectType: "Account", operation: "delete" } },
                name: "deleteAccount",
                displayName: "Delete Account",
                parameters: [
                    {
                        name: "recordId",
                        displayName: "Account ID",
                        type: o.objectReference({ objectType: "Account" }),
                    },
                ],
                logic: [],
            },
            {
                meta: { salesforce: { kind: "standard", apiName: "confirmSalesMeeting" } },
                name: "confirmSalesMeeting",
                displayName: "Confirm Sales Meeting",
                parameters: [
                    { name: "meetingRequestId", displayName: "Meeting Request ID", type: o.string({}) },
                ],
                logic: [],
            },
        ],
        queryFunctionTypes: [
            {
                name: "getAvailableMeetingTimes",
                displayName: "Get Available Meeting Times",
                parameters: [
                    {
                        name: "attendeeEmailAddresses",
                        displayName: "Attendee Email Addresses",
                        type: o.list({ elementType: o.string({}) }),
                    },
                ],
                returnType: o.struct({
                    fields: [
                        {
                            name: "timeSlots",
                            displayName: "Time Slots",
                            type: o.optional({ type: o.string({}) }),
                        },
                    ],
                }),
            },
        ],
    };

    const invokeFlowAction = vi.fn();
    const invokeStandardAction = vi.fn();
    const createRecord = vi.fn();
    const updateRecord = vi.fn();
    const deleteRecord = vi.fn();
    const query = vi.fn();
    const queryMore = vi.fn();
    const invalidate = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
    });

    function createAdapter(
        options: {
            live?: boolean;
            subscribeToChangeEvents?: Parameters<
                typeof createSalesforceOntologyBackendAdapter
            >[0]["subscribeToChangeEvents"];
        } = {}
    ) {
        return createSalesforceOntologyBackendAdapter({
            ir,
            live: options.live,
            subscribeToChangeEvents: options.subscribeToChangeEvents,
            client: {
                instanceUrl: "https://example.my.salesforce.com",
                apiVersion: "61.0",
                tokenProvider: () => "token",
                fetch: vi.fn() as typeof fetch,
                request: vi.fn(),
                describeGlobal: vi.fn(),
                describeSObject: vi.fn(),
                query,
                queryMore,
                createRecord,
                updateRecord,
                deleteRecord,
                subscribeToChangeEvents: vi.fn(),
                listFlowActions: vi.fn(),
                describeInvocableActions: vi.fn(),
                describeFlowAction: vi.fn(),
                describeFlowActions: vi.fn(),
                invokeFlowAction,
                listStandardActions: vi.fn(),
                describeStandardAction: vi.fn(),
                describeStandardActions: vi.fn(),
                invokeStandardAction,
            },
        });
    }

    it("invokes Flows by API name and invalidates collections on success", async () => {
        invokeFlowAction.mockResolvedValue([
            { isSuccess: true, outputValues: { Flow__InterviewStatus: "Finished" } },
        ]);
        const adapter = createAdapter();

        await adapter.applyAction(
            "Create_Account",
            { accountName: "Acme" },
            { objects: { Account: { utils: { invalidate } } as never } }
        );

        expect(invokeFlowAction).toHaveBeenCalledWith("Create_Account", [{ accountName: "Acme" }]);
        expect(invalidate).toHaveBeenCalledOnce();
    });

    it("does not subscribe or reconcile actions when live is false", async () => {
        const subscribeToChangeEvents = vi.fn();
        invokeFlowAction.mockResolvedValue([
            { isSuccess: true, outputValues: { Flow__InterviewStatus: "Finished" } },
        ]);
        const adapter = createAdapter({ live: false, subscribeToChangeEvents });
        const collectionOptions = adapter.getCollectionOptions("Account");
        collectionOptions.sync.sync({
            collection: { has: vi.fn(() => false), get: vi.fn() },
            begin: vi.fn(),
            write: vi.fn(),
            commit: vi.fn(() => true),
            markError: vi.fn(),
            markReady: vi.fn(),
        } as never);

        await adapter.applyAction(
            "Create_Account",
            { accountName: "Acme" },
            { objects: { Account: { utils: { invalidate } } as never } }
        );

        expect(adapter.live).toBe(false);
        expect(subscribeToChangeEvents).not.toHaveBeenCalled();
        expect(invalidate).not.toHaveBeenCalled();
    });

    it("maps validation failures to NonRetryableError", async () => {
        invokeFlowAction.mockRejectedValue(
            new SalesforceApiError("Required fields are missing", {
                statusCode: 400,
                errorCode: "REQUIRED_FIELD_MISSING",
            })
        );
        const adapter = createAdapter();

        await expect(adapter.applyAction("Create_Account", {}, { objects: {} })).rejects.toBeInstanceOf(
            NonRetryableError
        );
    });

    it("routes generated CRUD actions through sObject record APIs", async () => {
        createRecord.mockResolvedValue({ success: true, id: "001000000000001", errors: [] });
        updateRecord.mockResolvedValue({ success: true, id: "001000000000001", errors: [] });
        deleteRecord.mockResolvedValue({ success: true, id: "001000000000001", errors: [] });
        const deleteByKey = vi.fn(() => Promise.resolve());
        const refreshByKey = vi.fn().mockResolvedValue(undefined);
        const adapter = createAdapter();
        const live = { objects: { Account: { utils: { invalidate, refreshByKey, deleteByKey } } as never } };

        await adapter.applyAction("createAccount", { Name: "Acme" }, live);
        await adapter.applyAction("updateAccount", { recordId: "001000000000001", Name: "Acme 2" }, live);
        await adapter.applyAction("deleteAccount", { recordId: "001000000000001" }, live);

        expect(createRecord).toHaveBeenCalledWith("Account", { Name: "Acme" });
        expect(updateRecord).toHaveBeenCalledWith("Account", "001000000000001", { Name: "Acme 2" });
        expect(deleteRecord).toHaveBeenCalledWith("Account", "001000000000001");
        expect(refreshByKey).toHaveBeenNthCalledWith(1, "001000000000001");
        expect(refreshByKey).toHaveBeenNthCalledWith(2, "001000000000001");
        expect(invalidate).not.toHaveBeenCalled();
        expect(deleteByKey).toHaveBeenCalledWith("001000000000001");
        expect(invokeFlowAction).not.toHaveBeenCalled();
    });

    it("invokes standard actions and standard query functions", async () => {
        invokeStandardAction
            .mockResolvedValueOnce([{ isSuccess: true, outputValues: { meetingStatus: "Confirmed" } }])
            .mockResolvedValueOnce([{ isSuccess: true, outputValues: { timeSlots: "10:00 AM" } }]);
        const adapter = createAdapter();

        await adapter.applyAction("confirmSalesMeeting", { meetingRequestId: "request-1" }, { objects: {} });
        const result = await adapter.runQueryFunction(
            "getAvailableMeetingTimes",
            { attendeeEmailAddresses: ["a@example.com", "b@example.com"] },
            { objects: {} }
        );

        expect(invokeStandardAction).toHaveBeenNthCalledWith(1, "confirmSalesMeeting", [
            { meetingRequestId: "request-1" },
        ]);
        expect(invokeStandardAction).toHaveBeenNthCalledWith(2, "getAvailableMeetingTimes", [
            { attendeeEmailAddresses: ["a@example.com", "b@example.com"] },
        ]);
        expect(result).toEqual({ timeSlots: "10:00 AM" });
    });

    it("maps unsuccessful Flow results to NonRetryableError", async () => {
        invokeFlowAction.mockResolvedValue([
            { isSuccess: false, errors: [{ message: "Flow failed validation" }] },
        ]);
        const adapter = createAdapter();

        await expect(
            adapter.applyAction("Create_Account", { accountName: "Acme" }, { objects: {} })
        ).rejects.toEqual(
            expect.objectContaining({ name: "NonRetryableError", message: "Flow failed validation" })
        );
    });

    it("rejects unknown query functions", async () => {
        const adapter = createAdapter();
        await expect(adapter.runQueryFunction("currentUser", {}, { objects: {} })).rejects.toThrow(
            /Unknown Salesforce query function/
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
                    listStandardActions: vi.fn(),
                    describeStandardAction: vi.fn(),
                    invokeStandardAction,
                }) as never,
            live: false,
        });

        const adapter = await provider(ir, {});
        expect(adapter.name).toBe("salesforce");
        expect(adapter.live).toBe(false);
        expect(adapter.getCollectionOptions("Account").syncMode).toBe("on-demand");
    });
});
