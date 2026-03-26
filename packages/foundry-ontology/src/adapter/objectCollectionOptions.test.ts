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

vi.mock("./sync/ObjectSetWatcherManager.js", () => ({
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

import { objectCollectionOptions } from "./objectCollectionOptions.js";

function createSyncHarness(initialObjects: Array<Record<string, unknown>> = []) {
    const syncedData = new Map(
        initialObjects.map((object) => [object.employeeId as string | number, object])
    );
    const writes: Array<{ type: string; primaryKey: string | number }> = [];

    const { sync: syncConfig } = objectCollectionOptions({
        client: {
            baseUrl: "https://example.com",
            fetch: vi.fn(),
            ontologyRid: "ri.ontology.main",
            tokenProvider: () => Promise.resolve("token"),
        } as never,
        objectType: "Employee",
        primaryKeyProperty: "employeeId",
    });

    const handle = syncConfig.sync({
        begin: vi.fn(),
        collection: {
            syncedData,
        } as never,
        commit: vi.fn(),
        markReady: vi.fn(),
        truncate: vi.fn(),
        write: (mutation: Record<string, unknown>) => {
            const value = (mutation as { value: Record<string, unknown> }).value;
            const key = value.employeeId as string | number;
            writes.push({ type: mutation.type as string, primaryKey: key });
            if (mutation.type === "delete") {
                syncedData.delete(key);
            } else {
                syncedData.set(key, value);
            }
        },
    }) as { cleanup: () => void };

    return {
        cleanup: handle.cleanup,
        syncedData,
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

    it("skips delete edits in history (deletes come from watcher)", async () => {
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
        });

        expect(harness.syncedData.has(2)).toBe(true);
        expect(mockState.getObject).not.toHaveBeenCalled();

        harness.cleanup();
    });

    it("applies watcher REMOVED events as direct deletes", async () => {
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
});
