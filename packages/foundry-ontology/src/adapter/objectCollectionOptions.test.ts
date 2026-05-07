import { o } from "@party-stack/ontology";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
    getEditsHistory: vi.fn(),
    getObject: vi.fn(),
    subscribeCallback: undefined as
        | ((message: { type: string; status?: string; updates?: Array<Record<string, unknown>> }) => void)
        | undefined,
}));

vi.mock("@osdk/foundry.ontologies", () => ({
    OntologyObjectsV2: {
        get: mockState.getObject,
        search: vi.fn(),
    },
    ObjectTypesV2: {
        getEditsHistory: mockState.getEditsHistory,
    },
}));

vi.mock("@party-stack/foundry-object-set-watcher", () => ({
    getObjectSetWatcherManager: () => ({
        subscribe: (
            _objectSet: unknown,
            callback: (message: { type: string; status?: string; updates?: Array<Record<string, unknown>> }) => void
        ) => {
            mockState.subscribeCallback = callback;
            return () => {
                mockState.subscribeCallback = undefined;
            };
        },
    }),
}));

import { createFoundryCodec } from "./foundryCodec.js";
import { objectCollectionOptions } from "./objectCollectionOptions.js";

function createSyncHarness(
    initialObjects: Array<Record<string, unknown>> = [],
    opts: {
        decodeObject?: (object: Record<string, unknown>) => Record<string, unknown>;
    } = {}
) {
    const syncedData = new Map(
        initialObjects.map((object) => [object.employeeId as string | number, object])
    );
    const writes: Array<{ type: string; primaryKey: string | number }> = [];

    const { sync: syncConfig, utils } = objectCollectionOptions({
        client: {
            baseUrl: "https://example.com",
            fetch: vi.fn(),
            ontologyRid: "ri.ontology.main",
            tokenProvider: () => Promise.resolve("token"),
        } as never,
        objectType: "Employee",
        primaryKeyProperty: "employeeId",
        decodeObject: opts.decodeObject,
    });

    const handle = syncConfig.sync({
        begin: vi.fn(),
        collection: {
            *keys() {
                yield* syncedData.keys();
            },
            syncedData,
        } as never,
        commit: vi.fn(),
        markReady: vi.fn(),
        truncate: vi.fn(),
        write: (mutation: Record<string, unknown>) => {
            const key =
                mutation.type === "delete"
                    ? (mutation as { key: string | number }).key
                    : (((mutation as { value: Record<string, unknown> }).value
                          .employeeId as string | number));
            writes.push({ type: mutation.type as string, primaryKey: key });
            if (mutation.type === "delete") {
                syncedData.delete(key);
            } else {
                const value = (mutation as { value: Record<string, unknown> }).value;
                syncedData.set(key, value);
            }
        },
    }) as { cleanup: () => void };

    return {
        cleanup: handle.cleanup,
        syncedData,
        utils,
        writes,
    };
}

describe("objectCollectionOptions", () => {
    beforeEach(() => {
        mockState.getEditsHistory.mockReset();
        mockState.getObject.mockReset();
        mockState.subscribeCallback = undefined;
    });

    it("reconciles modify edits from history on watcher open", async () => {
        mockState.getEditsHistory.mockResolvedValue({
            data: [
                {
                    objectPrimaryKey: { employeeId: 1 },
                    operationId: "op-1",
                    actionTypeRid: "action-1",
                    userId: "user-1",
                    timestamp: "2099-03-12T12:00:00.000Z",
                    edit: {
                        type: "modifyEdit",
                        previousProperties: {},
                        properties: {
                            employeeId: 1,
                            name: "Updated Employee",
                        },
                    },
                },
            ],
            nextPageToken: undefined,
        });

        const harness = createSyncHarness();

        mockState.subscribeCallback?.({ type: "state", status: "open" });

        await vi.waitFor(() => {
            expect(mockState.getEditsHistory).toHaveBeenCalledTimes(1);
            expect(harness.syncedData.get(1)).toEqual({
                employeeId: 1,
                name: "Updated Employee",
            });
        });

        expect(mockState.getObject).not.toHaveBeenCalled();

        harness.cleanup();
    });

    it("applies delete edits from history", async () => {
        mockState.getEditsHistory.mockResolvedValue({
            data: [
                {
                    objectPrimaryKey: { employeeId: 2 },
                    operationId: "op-2",
                    actionTypeRid: "action-1",
                    userId: "user-1",
                    timestamp: "2099-03-12T12:01:00.000Z",
                    edit: {
                        type: "deleteEdit",
                        previousProperties: {},
                    },
                },
            ],
            nextPageToken: undefined,
        });

        const harness = createSyncHarness([{ employeeId: 2, name: "Should Stay" }]);

        mockState.subscribeCallback?.({ type: "state", status: "open" });

        await vi.waitFor(() => {
            expect(mockState.getEditsHistory).toHaveBeenCalledTimes(1);
            expect(harness.syncedData.has(2)).toBe(false);
        });

        expect(mockState.getObject).not.toHaveBeenCalled();

        harness.cleanup();
    });

    it("treats watcher REMOVED events as a history catch-up signal", async () => {
        mockState.getEditsHistory.mockResolvedValue({
            data: [
                {
                    objectPrimaryKey: { employeeId: 5 },
                    operationId: "op-5",
                    actionTypeRid: "action-1",
                    userId: "user-1",
                    timestamp: "2099-03-12T12:00:00.000Z",
                    edit: {
                        type: "createEdit",
                        properties: {
                            employeeId: 5,
                            name: "Employee Five",
                        },
                    },
                },
            ],
            nextPageToken: undefined,
        });
        mockState.getEditsHistory.mockResolvedValueOnce({
            data: [
                {
                    objectPrimaryKey: { employeeId: 5 },
                    operationId: "op-5",
                    actionTypeRid: "action-1",
                    userId: "user-1",
                    timestamp: "2099-03-12T12:00:00.000Z",
                    edit: {
                        type: "createEdit",
                        properties: {
                            employeeId: 5,
                            name: "Employee Five",
                        },
                    },
                },
            ],
            nextPageToken: undefined,
        });
        mockState.getEditsHistory.mockResolvedValueOnce({
            data: [
                {
                    objectPrimaryKey: { employeeId: 5 },
                    operationId: "op-6",
                    actionTypeRid: "action-1",
                    userId: "user-1",
                    timestamp: "2099-03-12T12:01:00.000Z",
                    edit: {
                        type: "deleteEdit",
                        previousProperties: {},
                    },
                },
            ],
            nextPageToken: undefined,
        });

        const harness = createSyncHarness();

        mockState.subscribeCallback?.({ type: "state", status: "open" });

        await vi.waitFor(() => {
            expect(harness.syncedData.has(5)).toBe(true);
        });

        mockState.subscribeCallback?.({
            type: "change",
            updates: [
                {
                    type: "object",
                    state: "REMOVED",
                    object: { employeeId: 5 },
                },
            ],
        });

        await vi.waitFor(() => {
            expect(mockState.getEditsHistory).toHaveBeenCalledTimes(2);
            expect(harness.syncedData.has(5)).toBe(false);
            expect(harness.writes).toContainEqual({ type: "delete", primaryKey: 5 });
        });

        harness.cleanup();
    });

    it("dedupes inclusive timestamp results across catch-up runs", async () => {
        mockState.getEditsHistory
            .mockResolvedValueOnce({
                data: [
                    {
                        objectPrimaryKey: { employeeId: 1 },
                        operationId: "op-1",
                        actionTypeRid: "action-1",
                        userId: "user-1",
                        timestamp: "2099-03-12T12:00:00.000Z",
                        edit: {
                            type: "modifyEdit",
                            previousProperties: {},
                            properties: {
                                employeeId: 1,
                                name: "Employee One",
                            },
                        },
                    },
                ],
                nextPageToken: undefined,
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        objectPrimaryKey: { employeeId: 1 },
                        operationId: "op-1",
                        actionTypeRid: "action-1",
                        userId: "user-1",
                        timestamp: "2099-03-12T12:00:00.000Z",
                        edit: {
                            type: "modifyEdit",
                            previousProperties: {},
                            properties: {
                                employeeId: 1,
                                name: "Employee One",
                            },
                        },
                    },
                    {
                        objectPrimaryKey: { employeeId: 2 },
                        operationId: "op-2",
                        actionTypeRid: "action-1",
                        userId: "user-1",
                        timestamp: "2099-03-12T12:00:00.000Z",
                        edit: {
                            type: "modifyEdit",
                            previousProperties: {},
                            properties: {
                                employeeId: 2,
                                name: "Employee Two",
                            },
                        },
                    },
                ],
                nextPageToken: undefined,
            });

        const harness = createSyncHarness();

        mockState.subscribeCallback?.({ type: "state", status: "open" });
        mockState.subscribeCallback?.({
            type: "change",
            updates: [
                {
                    type: "object",
                    state: "ADDED_OR_UPDATED",
                    object: { employeeId: 2, name: "Employee Two" },
                },
            ],
        });

        await vi.waitFor(() => {
            expect(mockState.getEditsHistory).toHaveBeenCalledTimes(2);
            expect(harness.syncedData.get(1)).toEqual({
                employeeId: 1,
                name: "Employee One",
            });
            expect(harness.syncedData.get(2)).toEqual({
                employeeId: 2,
                name: "Employee Two",
            });
        });

        expect(mockState.getObject).not.toHaveBeenCalled();

        harness.cleanup();
    });

    it("decodes create edits with null property sentinels from edit history", async () => {
        mockState.getEditsHistory.mockResolvedValue({
            data: [
                {
                    objectPrimaryKey: { employeeId: 3 },
                    operationId: "op-1",
                    actionTypeRid: "action-1",
                    userId: "user-1",
                    timestamp: "2099-03-12T12:00:00.000Z",
                    edit: {
                        type: "createEdit",
                        properties: {
                            employeeId: 3,
                            nickname: "NullPropertyValue{}",
                            name: "Employee Three",
                            createdAt: "2099-03-12T12:00:00.000Z",
                        },
                    },
                },
            ],
            nextPageToken: undefined,
        });

        const harness = createSyncHarness();

        mockState.subscribeCallback?.({ type: "state", status: "open" });

        await vi.waitFor(() => {
            expect(harness.syncedData.get(3)).toEqual({
                employeeId: 3,
                name: "Employee Three",
                nickname: undefined,
                createdAt: "2099-03-12T12:00:00.000Z",
            });
        });

        expect(mockState.getObject).not.toHaveBeenCalled();

        harness.cleanup();
    });

    it("decodes attachment property wrappers from edit history", async () => {
        mockState.getEditsHistory.mockResolvedValue({
            data: [
                {
                    objectPrimaryKey: { employeeId: 7 },
                    operationId: "op-7",
                    actionTypeRid: "action-1",
                    userId: "user-1",
                    timestamp: "2099-03-12T12:00:00.000Z",
                    edit: {
                        type: "createEdit",
                        properties: {
                            employeeId: 7,
                            attachments: [
                                {
                                    type: "attachment",
                                    attachment: "ri.attachments.main.attachment.7",
                                },
                            ],
                            name: "Employee Seven",
                        },
                    },
                },
            ],
            nextPageToken: undefined,
        });
        const codec = createFoundryCodec({
            types: [],
            objectTypes: [
                {
                    name: "Employee",
                    displayName: "Employee",
                    pluralDisplayName: "Employees",
                    primaryKey: "employeeId",
                    properties: [
                        { name: "employeeId", displayName: "Employee ID", type: o.integer({}) },
                        { name: "name", displayName: "Name", type: o.string({}) },
                        {
                            name: "attachments",
                            displayName: "Attachments",
                            type: o.list({
                                elementType: o.attachment({ meta: { type: "attachment" } }),
                            }),
                        },
                    ],
                },
            ],
            linkTypes: [],
            actionTypes: [],
        });

        const harness = createSyncHarness([], {
            decodeObject: (object) => codec.decodeObject("Employee", object),
        });

        mockState.subscribeCallback?.({ type: "state", status: "open" });

        await vi.waitFor(() => {
            expect(harness.syncedData.get(7)).toEqual({
                employeeId: 7,
                name: "Employee Seven",
                attachments: [{ id: "ri.attachments.main.attachment.7" }],
            });
        });

        harness.cleanup();
    });

    it("decodes GeoPointPropertyValue strings from edit history", async () => {
        mockState.getEditsHistory.mockResolvedValue({
            data: [
                {
                    objectPrimaryKey: { employeeId: 5 },
                    operationId: "op-1",
                    actionTypeRid: "action-1",
                    userId: "user-1",
                    timestamp: "2099-03-12T12:00:00.000Z",
                    edit: {
                        type: "createEdit",
                        properties: {
                            employeeId: 5,
                            name: "Employee Five",
                            location: "GeoPointPropertyValue{latitude: 40.375786, longitude: -74.11144}",
                        },
                    },
                },
            ],
            nextPageToken: undefined,
        });

        const harness = createSyncHarness();

        mockState.subscribeCallback?.({ type: "state", status: "open" });

        await vi.waitFor(() => {
            expect(harness.syncedData.get(5)).toEqual({
                employeeId: 5,
                name: "Employee Five",
                location: { lat: 40.375786, lon: -74.11144 },
            });
        });

        expect(mockState.getObject).not.toHaveBeenCalled();

        harness.cleanup();
    });

    it("unwraps tagged primary key values from edit history", async () => {
        mockState.getEditsHistory.mockResolvedValue({
            data: [
                {
                    objectPrimaryKey: {
                        employeeId: {
                            type: "stringValue",
                            value: "employee-4",
                        },
                    },
                    operationId: "op-1",
                    actionTypeRid: "action-1",
                    userId: "user-1",
                    timestamp: "2099-03-12T12:00:00.000Z",
                    edit: {
                        type: "createEdit",
                        properties: {
                            employeeId: {
                                type: "stringValue",
                                value: "employee-4",
                            },
                            name: "Employee Four",
                        },
                    },
                },
            ],
            nextPageToken: undefined,
        });

        const harness = createSyncHarness();

        mockState.subscribeCallback?.({ type: "state", status: "open" });

        await vi.waitFor(() => {
            expect(harness.syncedData.get("employee-4")).toEqual({
                employeeId: "employee-4",
                name: "Employee Four",
            });
        });

        expect(mockState.getObject).not.toHaveBeenCalled();

        harness.cleanup();
    });

    it("triggers history catch-up on ADDED_OR_UPDATED watcher events", async () => {
        mockState.getEditsHistory
            .mockResolvedValueOnce({
                data: [],
                nextPageToken: undefined,
            })
            .mockResolvedValueOnce({
                data: [
                    {
                        objectPrimaryKey: { employeeId: 10 },
                        operationId: "op-10",
                        actionTypeRid: "action-1",
                        userId: "user-1",
                        timestamp: "2099-03-12T12:05:00.000Z",
                        edit: {
                            type: "createEdit",
                            properties: {
                                employeeId: 10,
                                name: "New Employee",
                            },
                        },
                    },
                ],
                nextPageToken: undefined,
            });

        const harness = createSyncHarness();

        mockState.subscribeCallback?.({ type: "state", status: "open" });

        await vi.waitFor(() => {
            expect(mockState.getEditsHistory).toHaveBeenCalledTimes(1);
        });

        mockState.subscribeCallback?.({
            type: "change",
            updates: [
                {
                    type: "object",
                    state: "ADDED_OR_UPDATED",
                    object: { employeeId: 10, name: "New Employee" },
                },
            ],
        });

        await vi.waitFor(() => {
            expect(mockState.getEditsHistory).toHaveBeenCalledTimes(2);
            expect(harness.syncedData.get(10)).toEqual({
                employeeId: 10,
                name: "New Employee",
            });
        });

        harness.cleanup();
    });

    it("falls back to direct websocket updates when edit history is unavailable", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        mockState.getEditsHistory.mockRejectedValue(new Error("Edit history is not enabled"));

        const harness = createSyncHarness();

        mockState.subscribeCallback?.({
            type: "change",
            updates: [
                {
                    type: "object",
                    state: "ADDED_OR_UPDATED",
                    object: { employeeId: 12, name: "Direct Employee" },
                },
            ],
        });

        await vi.waitFor(() => {
            expect(mockState.getEditsHistory).toHaveBeenCalledTimes(1);
            expect(harness.syncedData.get(12)).toEqual({
                employeeId: 12,
                name: "Direct Employee",
            });
        });

        mockState.subscribeCallback?.({
            type: "change",
            updates: [
                {
                    type: "object",
                    state: "REMOVED",
                    object: { employeeId: 12 },
                },
            ],
        });

        await vi.waitFor(() => {
            expect(harness.syncedData.has(12)).toBe(false);
            expect(harness.writes).toContainEqual({ type: "delete", primaryKey: 12 });
        });

        expect(mockState.getEditsHistory).toHaveBeenCalledTimes(1);

        harness.cleanup();
        warnSpy.mockRestore();
    });

    it("resolves awaitOperationId after direct websocket sync observes an update", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        mockState.getEditsHistory.mockRejectedValue(new Error("Edit history is not enabled"));

        const harness = createSyncHarness();
        const operationPromise = harness.utils.awaitOperationId("op-12");

        await vi.waitFor(() => {
            expect(mockState.getEditsHistory).toHaveBeenCalledTimes(1);
        });

        mockState.subscribeCallback?.({
            type: "change",
            updates: [
                {
                    type: "object",
                    state: "ADDED_OR_UPDATED",
                    object: { employeeId: 13, name: "Direct Operation Employee" },
                },
            ],
        });

        await expect(operationPromise).resolves.toBe(true);
        expect(harness.syncedData.get(13)).toEqual({
            employeeId: 13,
            name: "Direct Operation Employee",
        });
        expect(mockState.getEditsHistory).toHaveBeenCalledTimes(1);

        harness.cleanup();
        warnSpy.mockRestore();
    });

    it("awaitOperationId resolves after the matching edit is observed", async () => {
        mockState.getEditsHistory.mockResolvedValue({
            data: [
                {
                    objectPrimaryKey: { employeeId: 11 },
                    operationId: "op-11",
                    actionTypeRid: "action-1",
                    userId: "user-1",
                    timestamp: "2099-03-12T12:06:00.000Z",
                    edit: {
                        type: "createEdit",
                        properties: {
                            employeeId: 11,
                            name: "Operation Eleven",
                        },
                    },
                },
            ],
            nextPageToken: undefined,
        });

        const harness = createSyncHarness();

        await expect(harness.utils.awaitOperationId("op-11")).resolves.toBe(true);

        expect(mockState.getEditsHistory).toHaveBeenCalledTimes(1);
        expect(harness.syncedData.get(11)).toEqual({
            employeeId: 11,
            name: "Operation Eleven",
        });

        harness.cleanup();
    });
});
