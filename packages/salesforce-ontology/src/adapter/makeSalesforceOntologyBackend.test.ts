import { o, type OntologyIR } from "@party-stack/ontology";
import { objectSubset, resolveSubsetSnapshot } from "@party-stack/ontology-backend/subset";
import { eq, field, inArray, like } from "@party-stack/ontology-storage";
import { SalesforceApiError } from "@party-stack/salesforce-client";
import { Effect, Fiber } from "effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeSalesforceOntologyBackend } from "./makeSalesforceOntologyBackend.js";
import type { BackendError, OntologyBackendService } from "@party-stack/ontology-backend";
import type { SalesforceClient } from "@party-stack/salesforce-client";

describe("makeSalesforceOntologyBackend", () => {
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
        } = {}
    ) {
        return makeSalesforceOntologyBackend({
            ir,

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

    it("does not trigger collection invalidation during native action execution", async () => {
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

        expect(invalidate).not.toHaveBeenCalled();
    });

    it("normalizes provider validation failures", async () => {
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

    it("normalizes unsuccessful Flow results", async () => {
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
                message: "Submission failed validation.",
                issues: [expect.objectContaining({ message: "Flow failed validation", category: "custom" })],
            })
        );
    });

    it("rejects unknown query functions", async () => {
        const adapter = createAdapter();
        await expect(queryNative(adapter, "currentUser", {}, { objects: {} })).rejects.toThrow(
            /Unknown Salesforce query function/
        );
    });

    function runNative<A>(
        adapter: ReturnType<typeof createAdapter>,
        use: (backend: OntologyBackendService) => Effect.Effect<A, BackendError>
    ): Promise<A> {
        return Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const backend = yield* adapter;
                    return yield* use({
                        ...backend,
                        loadSubset: (subset) =>
                            backend.loadSubset(subset).pipe(
                                Effect.flatMap((snapshot) => resolveSubsetSnapshot(ir, subset, snapshot)),
                                Effect.map((result) => result.snapshot)
                            ),
                    });
                })
            )
        );
    }

    it("synthesizes native CRUD receipts without collection reads, reconciliation, or CDC subscriptions", async () => {
        createRecord.mockResolvedValue({ success: true, id: "new", errors: [] });
        updateRecord.mockResolvedValue({ success: true, errors: [] });
        deleteRecord.mockResolvedValue({ success: true, errors: [] });
        const adapter = createAdapter();
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
            backend.loadSubset(
                objectSubset("Account", {
                    where: like(field("Name"), "match%"),
                    orderBy: [{ field: field("Name"), direction: "asc" }],
                    offset: 1,
                    limit: 1,
                })
            )
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
            backend.loadSubset(objectSubset("Account", { where: inArray(field("Id"), [key, key]) }))
        );
        expect(snapshot.rows.map((row) => row.key)).toEqual([key]);
        expect(query).toHaveBeenCalledExactlyOnceWith(
            "SELECT Id, Name FROM Account WHERE Id IN ('one\\' OR Name != \\'')"
        );
        query.mockClear();
        await runNative(createAdapter(), (backend) =>
            backend.loadSubset(objectSubset("Account", { where: eq(field("Id"), "one") }))
        );
        expect(query).toHaveBeenCalledExactlyOnceWith("SELECT Id, Name FROM Account WHERE Id IN ('one')");
    });

    it("does not issue SOQL for empty key demand", async () => {
        expect(
            await runNative(createAdapter(), (backend) =>
                backend.loadSubset(objectSubset("Account", { where: inArray(field("Id"), []) }))
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
                Effect.result(backend.loadSubset(objectSubset("Account")))
            );
            expect(result).toMatchObject({
                _tag: "Failure",
                failure: { kind: "InvalidResponse", retryable: false },
            });
        }
    });

    it("distinguishes rejected writes from unknown transport outcomes without retrying submission", async () => {
        for (const [cause, kind] of [
            [new SalesforceApiError("Invalid request", { statusCode: 400 }), "InvalidRequest"],
            [
                new SalesforceApiError("Constraint failed", {
                    statusCode: 400,
                    errorCode: "FIELD_CUSTOM_VALIDATION_EXCEPTION",
                }),
                "ValidationFailed",
            ],
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
        expect(createRecord).toHaveBeenCalledTimes(3);
        expect(query).not.toHaveBeenCalled();
    });

    it("rejects invalid subset windows through the typed error channel before SOQL", async () => {
        const result = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const backend = yield* createAdapter();
                    return yield* Effect.result(backend.loadSubset(objectSubset("Account", { limit: -1 })));
                })
            )
        );
        expect(result).toMatchObject({
            _tag: "Failure",
            failure: { kind: "InvalidRequest", retryable: false },
        });
        expect(query).not.toHaveBeenCalled();
        expect(queryMore).not.toHaveBeenCalled();
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
                    const backend = yield* adapter;
                    yield* backend.loadSubset(objectSubset("Account"));
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
    it("does not retry malformed or missing action results", async () => {
        for (const result of [[], [{ isSuccess: "true" }], [{ isSuccess: true }, { isSuccess: true }]]) {
            invokeFlowAction.mockResolvedValue(result);
            const outcome = await runNative(createAdapter(), (backend) =>
                Effect.result(backend.applyAction({ id: "once", name: "Create_Account", parameters: {} }))
            );
            expect(outcome).toMatchObject({
                _tag: "Failure",
                failure: { kind: "InvalidResponse", actionOutcome: "unknown", retryable: false },
            });
        }
        expect(invokeFlowAction).toHaveBeenCalledTimes(3);
        createRecord.mockResolvedValue({ id: "maybe-committed" });
        const outcome = await runNative(createAdapter(), (backend) =>
            Effect.result(backend.applyAction({ id: "once", name: "createAccount", parameters: {} }))
        );
        expect(outcome).toMatchObject({
            _tag: "Failure",
            failure: { kind: "InvalidResponse", actionOutcome: "unknown", retryable: false },
        });
    });

    it("accepts the provider's documented null error list on successful flows", async () => {
        invokeFlowAction.mockResolvedValue([{ isSuccess: true, errors: null, outputValues: null }]);
        expect(
            await runNative(createAdapter(), (backend) =>
                backend.applyAction({ id: "once", name: "Create_Account", parameters: {} })
            )
        ).toMatchObject({ outcome: "committed" });
    });

    it("distinguishes permission and throttling rejections from validation issues", async () => {
        for (const [code, kind, retryable] of [
            ["INSUFFICIENT_ACCESS_OR_READONLY", "Forbidden", false],
            ["REQUEST_LIMIT_EXCEEDED", "RateLimited", true],
        ] as const) {
            invokeFlowAction.mockResolvedValue([
                { isSuccess: false, errors: [{ statusCode: code, message: "private provider detail" }] },
            ]);
            const outcome = await runNative(createAdapter(), (backend) =>
                Effect.result(backend.applyAction({ id: "once", name: "Create_Account", parameters: {} }))
            );
            expect(outcome).toMatchObject({
                _tag: "Failure",
                failure: { kind, retryable, actionOutcome: "not-committed" },
            });
            if (outcome._tag === "Failure")
                expect(outcome.failure.message).not.toContain("private provider detail");
        }
    });

    it("rejects invalid action names and missing metadata before any write", async () => {
        const adapter = makeSalesforceOntologyBackend({
            ir: {
                ...ir,
                actionTypes: [
                    ...ir.actionTypes,
                    { name: "unconfigured", displayName: "Unconfigured", parameters: [], logic: [] },
                ],
            },
            client: {
                instanceUrl: "https://example.my.salesforce.com",
                invokeFlowAction,
                createRecord,
            } as unknown as SalesforceClient,
        });
        for (const [name, kind] of [
            ["missing", "InvalidRequest"],
            ["unconfigured", "InvalidConfiguration"],
        ]) {
            const outcome = await runNative(adapter, (backend) =>
                Effect.result(backend.applyAction({ id: "once", name: name!, parameters: {} }))
            );
            expect(outcome).toMatchObject({
                _tag: "Failure",
                failure: { kind, retryable: false, actionOutcome: "not-committed" },
            });
        }
        expect(invokeFlowAction).not.toHaveBeenCalled();
        expect(createRecord).not.toHaveBeenCalled();
    });

    it("rejects repeated or malformed provider pages", async () => {
        query.mockResolvedValue({ done: false, nextRecordsUrl: "/same", records: [] });
        queryMore.mockResolvedValue({ done: false, nextRecordsUrl: "/same", records: [] });
        const outcome = await runNative(createAdapter(), (backend) =>
            Effect.result(backend.loadSubset(objectSubset("Account")))
        );
        expect(outcome).toMatchObject({
            _tag: "Failure",
            failure: { kind: "InvalidResponse", retryable: false },
        });
        expect(queryMore).toHaveBeenCalledOnce();
        for (const page of [
            { done: "true", records: [] },
            { done: true, records: null },
        ]) {
            query.mockResolvedValue(page);
            expect(
                await runNative(createAdapter(), (backend) =>
                    Effect.result(backend.loadSubset(objectSubset("Account")))
                )
            ).toMatchObject({ _tag: "Failure", failure: { kind: "InvalidResponse", retryable: false } });
        }
    });
});

function applyNative(
    adapter: ReturnType<typeof makeSalesforceOntologyBackend>,
    name: string,
    parameters: Record<string, unknown>,
    options: {
        context?: Record<string, unknown>;
        idempotencyKey?: string;
        objects?: unknown;
        attachmentUploads?: import("@party-stack/ontology-backend").AttachmentUpload[];
    }
) {
    return Effect.runPromise(
        Effect.scoped(
            Effect.flatMap(adapter, (backend) =>
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
    adapter: ReturnType<typeof makeSalesforceOntologyBackend>,
    name: string,
    parameters: Record<string, unknown>,
    _options: { context?: Record<string, unknown>; objects?: unknown }
) {
    return Effect.runPromise(
        Effect.scoped(Effect.flatMap(adapter, (backend) => backend.queryFunction(name, parameters)))
    );
}
