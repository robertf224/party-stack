import { o, type OntologyIR } from "@party-stack/ontology";
import { eq, field, inArray, like } from "@party-stack/ontology-storage";
import { SalesforceApiError } from "@party-stack/salesforce-client";
import { Effect, Fiber } from "effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
    createSalesforceOntologyBackend,
    createSalesforceOntologyBackendAdapter,
} from "./createSalesforceOntologyBackendAdapter.js";
import type { BackendError, OntologyBackendService } from "@party-stack/ontology-backend";
import type { SalesforceClient } from "@party-stack/salesforce-client";

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
                meta: {
                    salesforce: {
                        kind: "flow",
                        apiName: "Create_Account",
                    },
                },
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
            {
                meta: {
                    salesforce: {
                        kind: "crud",
                        objectType: "Account",
                        operation: "create",
                    },
                },
                name: "createAccount",
                displayName: "Create Account",
                parameters: [
                    {
                        name: "Name",
                        displayName: "Name",
                        type: o.string({}),
                    },
                ],
                logic: [],
            },
            {
                meta: {
                    salesforce: {
                        kind: "crud",
                        objectType: "Account",
                        operation: "update",
                    },
                },
                name: "updateAccount",
                displayName: "Update Account",
                parameters: [
                    {
                        name: "recordId",
                        displayName: "Account ID",
                        type: o.objectReference({
                            objectType: "Account",
                        }),
                    },
                    {
                        name: "Name",
                        displayName: "Name",
                        type: o.optional({
                            type: o.string({}),
                        }),
                    },
                ],
                logic: [],
            },
            {
                meta: {
                    salesforce: {
                        kind: "crud",
                        objectType: "Account",
                        operation: "delete",
                    },
                },
                name: "deleteAccount",
                displayName: "Delete Account",
                parameters: [
                    {
                        name: "recordId",
                        displayName: "Account ID",
                        type: o.objectReference({
                            objectType: "Account",
                        }),
                    },
                ],
                logic: [],
            },
            {
                meta: {
                    salesforce: {
                        kind: "standard",
                        apiName: "confirmSalesMeeting",
                    },
                },
                name: "confirmSalesMeeting",
                displayName: "Confirm Sales Meeting",
                parameters: [
                    {
                        name: "meetingRequestId",
                        displayName: "Meeting Request ID",
                        type: o.string({}),
                    },
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
                        type: o.list({
                            elementType: o.string({}),
                        }),
                    },
                ],
                returnType: o.struct({
                    fields: [
                        {
                            name: "timeSlots",
                            displayName: "Time Slots",
                            type: o.optional({
                                type: o.string({}),
                            }),
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
            client?: Partial<SalesforceClient>;
            subscribeToChangeEvents?: Parameters<
                typeof createSalesforceOntologyBackendAdapter
            >[0]["subscribeToChangeEvents"];
        } = {}
    ) {
        return createSalesforceOntologyBackendAdapter({
            ir,

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
                ...options.client,
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

        await applyNative(
            adapter,
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

        expect(invokeFlowAction).toHaveBeenCalledWith("Create_Account", [{ accountName: "Acme" }]);
        expect(invalidate).not.toHaveBeenCalled();
    });

    it("does not subscribe or reconcile actions when live is false", async () => {
        const subscribeToChangeEvents = vi.fn();
        invokeFlowAction.mockResolvedValue([
            {
                isSuccess: true,
                outputValues: { Flow__InterviewStatus: "Finished" },
            },
        ]);
        const adapter = createAdapter({
            subscribeToChangeEvents,
        });
        await applyNative(
            adapter,
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

        await expect(applyNative(adapter, "Create_Account", {}, { objects: {} })).rejects.toMatchObject({
            kind: "ValidationFailed",
        });
    });

    it("routes generated CRUD actions through sObject record APIs", async () => {
        createRecord.mockResolvedValue({
            success: true,
            id: "001000000000001",
            errors: [],
        });
        updateRecord.mockResolvedValue({
            success: true,
            id: "001000000000001",
            errors: [],
        });
        deleteRecord.mockResolvedValue({
            success: true,
            id: "001000000000001",
            errors: [],
        });
        const deleteByKey = vi.fn(() => Promise.resolve());
        const refreshByKey = vi.fn().mockResolvedValue(undefined);
        const adapter = createAdapter();
        const live = {
            objects: {
                Account: {
                    utils: {
                        invalidate,
                        refreshByKey,
                        deleteByKey,
                    },
                } as never,
            },
        };

        await applyNative(adapter, "createAccount", { Name: "Acme" }, live);
        await applyNative(
            adapter,
            "updateAccount",
            {
                recordId: "001000000000001",
                Name: "Acme 2",
            },
            live
        );
        await applyNative(adapter, "deleteAccount", { recordId: "001000000000001" }, live);

        expect(createRecord).toHaveBeenCalledWith("Account", { Name: "Acme" });
        expect(updateRecord).toHaveBeenCalledWith("Account", "001000000000001", { Name: "Acme 2" });
        expect(deleteRecord).toHaveBeenCalledWith("Account", "001000000000001");
        expect(refreshByKey).not.toHaveBeenCalled();
        expect(refreshByKey).not.toHaveBeenCalled();
        expect(invalidate).not.toHaveBeenCalled();
        expect(deleteByKey).not.toHaveBeenCalled();
        expect(invokeFlowAction).not.toHaveBeenCalled();
    });

    it("invokes standard actions and standard query functions", async () => {
        invokeStandardAction
            .mockResolvedValueOnce([
                {
                    isSuccess: true,
                    outputValues: {
                        meetingStatus: "Confirmed",
                    },
                },
            ])
            .mockResolvedValueOnce([
                {
                    isSuccess: true,
                    outputValues: {
                        timeSlots: "10:00 AM",
                    },
                },
            ]);
        const adapter = createAdapter();

        await applyNative(adapter, "confirmSalesMeeting", { meetingRequestId: "request-1" }, { objects: {} });
        const result = await queryNative(
            adapter,
            "getAvailableMeetingTimes",
            {
                attendeeEmailAddresses: ["a@example.com", "b@example.com"],
            },
            { objects: {} }
        );

        expect(invokeStandardAction).toHaveBeenNthCalledWith(1, "confirmSalesMeeting", [
            { meetingRequestId: "request-1" },
        ]);
        expect(invokeStandardAction).toHaveBeenNthCalledWith(2, "getAvailableMeetingTimes", [
            {
                attendeeEmailAddresses: ["a@example.com", "b@example.com"],
            },
        ]);
        expect(result).toEqual({
            timeSlots: "10:00 AM",
        });
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
            applyNative(adapter, "Create_Account", { accountName: "Acme" }, { objects: {} })
        ).rejects.toEqual(
            expect.objectContaining({
                kind: "ValidationFailed",
                message: "Flow failed validation",
            })
        );
    });

    it("rejects unknown query functions", async () => {
        const adapter = createAdapter();
        await expect(queryNative(adapter, "currentUser", {}, { objects: {} })).rejects.toThrow(
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
        });

        const adapter = await provider(ir, {});
        expect(adapter.name).toBe("salesforce");
        expect(adapter.open).toBeTypeOf("function");
    });
    function runNative<A>(
        adapter: ReturnType<typeof createAdapter>,
        use: (backend: OntologyBackendService) => Effect.Effect<A, BackendError>
    ): Promise<A> {
        return Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const backend = yield* adapter.open!({});
                    return yield* use(backend);
                })
            )
        );
    }

    it("synthesizes native CRUD receipts without collection reads, reconciliation, or CDC subscriptions", async () => {
        createRecord.mockResolvedValue({ success: true, id: "new", errors: [] });
        updateRecord.mockResolvedValue({ success: true, errors: [] });
        deleteRecord.mockResolvedValue({ success: true, errors: [] });
        const subscribeToChangeEvents = vi.fn();
        const adapter = createAdapter({ subscribeToChangeEvents });
        await runNative(adapter, (backend) =>
            Effect.gen(function* () {
                expect(backend.supportsIdempotency).toBe(false);
                expect(backend.changes).toBeUndefined();
                for (const [name, key, parameters] of [
                    ["createAccount", "new", { Name: "Acme" }],
                    ["updateAccount", "existing", { recordId: "existing", Name: "Changed" }],
                    ["deleteAccount", "existing", { recordId: "existing" }],
                ] as const) {
                    expect(yield* backend.applyAction({ id: name, name, parameters })).toEqual({
                        operationId: name,
                        outcome: "committed",
                        affected: [{ objectType: "Account", keys: [key] }],
                        affectedComplete: false,
                    });
                }
            })
        );
        expect(createRecord).toHaveBeenCalledExactlyOnceWith("Account", { Name: "Acme" });
        expect(updateRecord).toHaveBeenCalledExactlyOnceWith("Account", "existing", { Name: "Changed" });
        expect(deleteRecord).toHaveBeenCalledExactlyOnceWith("Account", "existing");
        expect(query).not.toHaveBeenCalled();
        expect(subscribeToChangeEvents).not.toHaveBeenCalled();
        expect(invalidate).not.toHaveBeenCalled();
    });

    it("invokes native flows and query functions directly with codec parameters and results", async () => {
        invokeFlowAction.mockResolvedValue([{ isSuccess: true }]);
        invokeStandardAction.mockResolvedValue([
            { isSuccess: true, outputValues: { timeSlots: "10:00 AM" } },
        ]);
        await runNative(createAdapter(), (backend) =>
            Effect.gen(function* () {
                expect(
                    yield* backend.applyAction({
                        id: "flow",
                        name: "Create_Account",
                        parameters: { accountName: "Acme" },
                    })
                ).toEqual({
                    operationId: "flow",
                    outcome: "committed",
                    affected: [{ objectType: "Account" }],
                });
                expect(
                    yield* backend.queryFunction("getAvailableMeetingTimes", {
                        attendeeEmailAddresses: ["a@example.com"],
                    })
                ).toEqual({ timeSlots: "10:00 AM" });
            })
        );
        expect(invokeFlowAction).toHaveBeenCalledExactlyOnceWith("Create_Account", [{ accountName: "Acme" }]);
        expect(invokeStandardAction).toHaveBeenCalledExactlyOnceWith("getAvailableMeetingTimes", [
            { attendeeEmailAddresses: ["a@example.com"] },
        ]);
        expect(query).not.toHaveBeenCalled();
    });

    it("loads all SOQL pages before local filtering, ordering and windowing", async () => {
        query.mockResolvedValue({
            done: false,
            nextRecordsUrl: "/next",
            records: [
                { Id: "one", Name: "other" },
                { Id: "two", Name: "match Z", attributes: { type: "Account" } },
            ],
        });
        queryMore.mockResolvedValue({ done: true, records: [{ Id: "three", Name: "match A" }] });
        const snapshot = await runNative(createAdapter(), (backend) =>
            backend.loadSubset({
                objectType: "Account",
                query: {
                    where: like(field("Name"), "match%"),
                    orderBy: [{ field: field("Name"), direction: "asc" }],
                    offset: 1,
                    limit: 1,
                },
            })
        );
        expect(snapshot).toEqual({
            complete: true,
            fetchedRows: 3,
            rows: [{ key: "two", value: { Id: "two", Name: "match Z" } }],
        });
        expect(query).toHaveBeenCalledExactlyOnceWith("SELECT Id, Name FROM Account");
        expect(queryMore).toHaveBeenCalledExactlyOnceWith("/next");
    });

    it("pushes primary-key batches into shared SOQL reads and escapes literal values", async () => {
        const key = "one' OR Name != '";
        query.mockResolvedValue({ done: true, records: [{ Id: key, Name: "Acme" }] });
        const snapshot = await runNative(createAdapter(), (backend) =>
            backend.loadSubset({
                objectType: "Account",
                query: { where: inArray(field("Id"), [key, key]) },
            })
        );
        expect(snapshot.rows.map((row) => row.key)).toEqual([key]);
        expect(query).toHaveBeenCalledExactlyOnceWith(
            "SELECT Id, Name FROM Account WHERE Id IN ('one\\' OR Name != \\'')"
        );
        query.mockClear();
        await runNative(createAdapter(), (backend) =>
            backend.loadSubset({ objectType: "Account", query: { where: eq(field("Id"), "one") } })
        );
        expect(query).toHaveBeenCalledExactlyOnceWith("SELECT Id, Name FROM Account WHERE Id IN ('one')");
    });

    it("does not issue SOQL for empty key demand", async () => {
        expect(
            await runNative(createAdapter(), (backend) =>
                backend.loadSubset({ objectType: "Account", query: { where: inArray(field("Id"), []) } })
            )
        ).toEqual({ rows: [], fetchedRows: 0, complete: true });
        expect(query).not.toHaveBeenCalled();
    });

    it("fails incomplete pages and malformed row identities rather than publishing complete snapshots", async () => {
        for (const response of [
            { done: false, records: [{ Id: "one", Name: "Acme" }] },
            { done: true, records: [{ Name: "No identity" }] },
        ]) {
            query.mockResolvedValue(response);
            const result = await runNative(createAdapter(), (backend) =>
                Effect.result(backend.loadSubset({ objectType: "Account" }))
            );
            expect(result).toMatchObject({
                _tag: "Failure",
                failure: { kind: "Unavailable", retryable: true },
            });
        }
    });

    it("distinguishes rejected writes from unknown transport outcomes without retrying submission", async () => {
        for (const [cause, kind] of [
            [new SalesforceApiError("ValidationFailed", { statusCode: 400 }), "ValidationFailed"],
            [new Error("Lost response"), "Unavailable"],
        ] as const) {
            createRecord.mockRejectedValue(cause);
            const result = await runNative(createAdapter(), (backend) =>
                Effect.result(
                    backend.applyAction({ id: "once", name: "createAccount", parameters: { Name: "Acme" } })
                )
            );
            expect(result).toMatchObject({
                _tag: "Failure",
                failure: { kind, retryable: kind === "Unavailable" },
            });
        }
        expect(createRecord).toHaveBeenCalledTimes(2);
        expect(query).not.toHaveBeenCalled();
    });

    it("cancels bound SOQL requests with their Effect fiber", async () => {
        let signal: AbortSignal | undefined;
        const transport = { query: vi.fn(() => new Promise<never>(() => {})) };
        const withSignal = vi.fn((value: AbortSignal) => {
            signal = value;
            return transport as unknown as SalesforceClient;
        });
        const adapter = createAdapter({ client: { withSignal } });
        const fiber = Effect.runFork(
            Effect.scoped(
                Effect.gen(function* () {
                    const backend = yield* adapter.open!({});
                    yield* backend.loadSubset({ objectType: "Account" });
                })
            )
        );
        try {
            await vi.waitFor(() => expect(transport.query).toHaveBeenCalledOnce());
        } finally {
            await Effect.runPromise(Fiber.interrupt(fiber));
        }
        expect(signal?.aborted).toBe(true);
        expect(queryMore).not.toHaveBeenCalled();
    });
});

function applyNative(
    adapter: import("@party-stack/ontology").OntologyBackendAdapter,
    name: string,
    parameters: Record<string, unknown>,
    options: {
        context?: Record<string, unknown>;
        idempotencyKey?: string;
        objects?: unknown;
        attachmentUploads?: import("@party-stack/ontology").OntologyAttachmentUpload[];
    }
) {
    return Effect.runPromise(
        Effect.scoped(
            Effect.flatMap(adapter.open(options.context ?? {}), (backend) =>
                backend.applyAction({
                    id: options.idempotencyKey ?? "test-invocation",
                    name,
                    parameters,
                    attachmentUploads: options.attachmentUploads,
                })
            )
        )
    ).then((receipt) => ({ receipt, attachmentIdMappings: receipt.attachmentIdMappings }));
}

function queryNative(
    adapter: import("@party-stack/ontology").OntologyBackendAdapter,
    name: string,
    parameters: Record<string, unknown>,
    options: { context?: Record<string, unknown>; objects?: unknown }
) {
    return Effect.runPromise(
        Effect.scoped(
            Effect.flatMap(adapter.open(options.context ?? {}), (backend) =>
                backend.queryFunction(name, parameters)
            )
        )
    );
}
