import { o } from "@party-stack/ontology";
import { eq, gt, IR, type LoadSubsetOptions } from "@tanstack/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
    getEditsHistory: vi.fn(),
    getObject: vi.fn(),
    search: vi.fn(),
    subscribeCallback: undefined as
        | ((message: { type: string; status?: string; updates?: Array<Record<string, unknown>> }) => void)
        | undefined,
}));

vi.mock("@osdk/foundry.ontologies", () => ({
    OntologyObjectsV2: {
        get: mockState.getObject,
        search: mockState.search,
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
        commitReceipt?: () => true | Promise<void>;
        decodeObject?: (object: Record<string, unknown>) => Record<string, unknown>;
        collectionMetadata?: Map<string, unknown>;
    } = {}
) {
    const syncedData = new Map(
        initialObjects.map((object) => [object.employeeId as string | number, object])
    );
    const writes: Array<{ type: string; primaryKey: string | number }> = [];
    const collectionMetadata = opts.collectionMetadata ?? new Map<string, unknown>();
    const transactions: Array<{
        writes: Array<{ type: string; primaryKey: string | number }>;
        collectionMetadata: Map<string, unknown>;
    }> = [];
    let pendingTransaction:
        | {
              writes: Array<{ type: string; primaryKey: string | number }>;
              collectionMetadata: Map<string, unknown>;
          }
        | undefined;
    const begin = vi.fn(() => {
        if (pendingTransaction) throw new Error("A sync transaction is already active.");
        pendingTransaction = {
            writes: [],
            collectionMetadata: new Map(),
        };
    });
    const commit = vi.fn(() => {
        if (!pendingTransaction) throw new Error("No sync transaction is active.");
        for (const [key, value] of pendingTransaction.collectionMetadata) {
            collectionMetadata.set(key, value);
        }
        transactions.push(pendingTransaction);
        pendingTransaction = undefined;
        return opts.commitReceipt?.() ?? true;
    });
    const truncate = vi.fn(() => {
        if (!pendingTransaction) {
            throw new Error(
                "No sync transaction is active."
            );
        }
        syncedData.clear();
    });

    const { sync: syncConfig, utils } = objectCollectionOptions({
        client: {
            baseUrl: "https://example.com",
            fetch: vi.fn(),
            ontologyRid: "ri.ontology.main",
            tokenProvider: () => Promise.resolve("token"),
        } as never,
        objectType: "Employee",
        primaryKeyProperty: "employeeId",
        selectedProperties: [
            "employeeId",
            "name",
            "status",
            "priority",
        ],
        decodeObject: opts.decodeObject,
    });

    const handle = syncConfig.sync({
        begin,
        collection: {
            get: (key: string | number) =>
                syncedData.get(key),
            has: (key: string | number) =>
                syncedData.has(key),
            *keys() {
                yield* syncedData.keys();
            },
            syncedData,
        } as never,
        commit,
        markError: vi.fn(),
        markReady: vi.fn(),
        metadata: {
            collection: {
                get: (key: string) =>
                    pendingTransaction?.collectionMetadata.get(key) ?? collectionMetadata.get(key),
                set: (key: string, value: unknown) => {
                    if (!pendingTransaction) throw new Error("No sync transaction is active.");
                    pendingTransaction.collectionMetadata.set(key, value);
                },
                delete: vi.fn(),
                list: () => [...collectionMetadata].map(([key, value]) => ({ key, value })),
            },
            row: {
                get: vi.fn(),
                set: vi.fn(),
                delete: vi.fn(),
            },
        },
        truncate,
        write: (mutation: Record<string, unknown>) => {
            if (!pendingTransaction) throw new Error("No sync transaction is active.");
            const key =
                mutation.type === "delete"
                    ? (mutation as { key: string | number }).key
                    : (((mutation as { value: Record<string, unknown> }).value
                          .employeeId as string | number));
            const observedWrite = { type: mutation.type as string, primaryKey: key };
            writes.push(observedWrite);
            pendingTransaction.writes.push(observedWrite);
            if (mutation.type === "delete") {
                syncedData.delete(key);
            } else {
                const value = (mutation as { value: Record<string, unknown> }).value;
                syncedData.set(key, value);
            }
        },
    }) as { cleanup: () => void; loadSubset: (options: LoadSubsetOptions) => Promise<void> };

    return {
        begin,
        cleanup: handle.cleanup,
        collectionMetadata,
        commit,
        loadSubset: handle.loadSubset,
        syncedData,
        transactions,
        truncate,
        utils,
        writes,
    };
}

describe("objectCollectionOptions", () => {
    beforeEach(() => {
        mockState.getEditsHistory.mockReset();
        mockState.getObject.mockReset();
        mockState.search.mockReset();
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

        const harness = createSyncHarness([
            {
                employeeId: 1,
                name: "Before",
                department: "Engineering",
            },
        ]);

        mockState.subscribeCallback?.({ type: "state", status: "open" });

        await vi.waitFor(() => {
            expect(mockState.getEditsHistory).toHaveBeenCalledTimes(1);
            expect(harness.syncedData.get(1)).toEqual({
                employeeId: 1,
                name: "Updated Employee",
                department: "Engineering",
            });
        });

        expect(mockState.getObject).not.toHaveBeenCalled();
        expect(harness.begin.mock.calls).toEqual([
            [],
            [],
        ]);

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

    it("deletes objects hydrated after source sync starts", async () => {
        mockState.getEditsHistory.mockResolvedValue({
            data: [
                {
                    objectPrimaryKey: {
                        employeeId: 2,
                    },
                    operationId: "op-hydrated-delete",
                    actionTypeRid: "action-1",
                    userId: "user-1",
                    timestamp:
                        "2099-03-12T12:01:00.000Z",
                    edit: {
                        type: "deleteEdit",
                        previousProperties: {},
                    },
                },
            ],
            nextPageToken: undefined,
        });
        const harness = createSyncHarness();

        // Persisted on-demand hydration happens after the source sync closure
        // captures its initial state.
        harness.syncedData.set(2, {
            employeeId: 2,
            name: "Persisted stale object",
        });
        mockState.subscribeCallback?.({
            type: "state",
            status: "open",
        });

        await vi.waitFor(() => {
            expect(
                harness.syncedData.has(2)
            ).toBe(false);
        });
        expect(harness.writes).toContainEqual({
            type: "delete",
            primaryKey: 2,
        });
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

    it("restores a durable same-timestamp cursor and catches downtime edits once", async () => {
        const timestamp = "2099-03-12T12:00:00.000Z";
        const firstEntry = {
            objectPrimaryKey: { employeeId: 1 },
            operationId: "op-1",
            actionTypeRid: "action-1",
            userId: "user-1",
            timestamp,
            edit: {
                type: "modifyEdit",
                previousProperties: {},
                properties: {
                    employeeId: 1,
                    name: "Employee One",
                },
            },
        };
        const downtimeEntry = {
            objectPrimaryKey: { employeeId: 2 },
            operationId: "op-2",
            actionTypeRid: "action-1",
            userId: "user-1",
            timestamp,
            edit: {
                type: "modifyEdit",
                previousProperties: {},
                properties: {
                    employeeId: 2,
                    name: "Employee Two",
                },
            },
        };
        const collectionMetadata = new Map<string, unknown>();
        mockState.getEditsHistory.mockResolvedValue({
            data: [firstEntry],
            nextPageToken: undefined,
        });

        const first = createSyncHarness([], { collectionMetadata });
        mockState.subscribeCallback?.({ type: "state", status: "open" });

        await vi.waitFor(() => {
            expect(first.syncedData.get(1)).toMatchObject({ name: "Employee One" });
        });
        const persistedCursor = [...collectionMetadata.values()][0] as {
            version: number;
            timestamp: string;
            seenEntryKeysAtTimestamp: string[];
        };
        expect(persistedCursor).toMatchObject({
            version: 1,
            timestamp,
        });
        expect(persistedCursor.seenEntryKeysAtTimestamp).toHaveLength(1);
        expect(first.transactions.at(-1)).toMatchObject({
            writes: [{ type: "insert", primaryKey: 1 }],
        });
        expect(first.transactions.at(-1)?.collectionMetadata.size).toBe(1);

        const reloadedObjects = [...first.syncedData.values()];
        first.cleanup();
        mockState.getEditsHistory.mockReset();
        mockState.getEditsHistory.mockResolvedValue({
            data: [firstEntry, downtimeEntry],
            nextPageToken: undefined,
        });

        const second = createSyncHarness(reloadedObjects, { collectionMetadata });
        mockState.subscribeCallback?.({ type: "state", status: "open" });

        await vi.waitFor(() => {
            expect(second.syncedData.get(2)).toMatchObject({ name: "Employee Two" });
        });
        expect(second.writes).toEqual([{ type: "insert", primaryKey: 2 }]);
        expect(mockState.getEditsHistory.mock.calls[0]?.[3]).toMatchObject({
            filters: {
                type: "timestampFilter",
                startTime: timestamp,
            },
        });
        expect(
            (
                [...collectionMetadata.values()][0] as {
                    seenEntryKeysAtTimestamp: string[];
                }
            ).seenEntryKeysAtTimestamp
        ).toHaveLength(2);

        second.cleanup();
    });

    it("persists delete and cursor progress for unloaded rows", async () => {
        const timestamp = "2099-03-12T12:02:00.000Z";
        mockState.getEditsHistory.mockResolvedValue({
            data: [
                {
                    objectPrimaryKey: { employeeId: 404 },
                    operationId: "op-delete-missing",
                    actionTypeRid: "action-1",
                    userId: "user-1",
                    timestamp,
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
            expect(harness.transactions).toHaveLength(2);
        });
        expect(harness.writes).toEqual([
            {
                type: "delete",
                primaryKey: 404,
            },
        ]);
        expect(
            harness.transactions.at(-1)?.writes
        ).toEqual([
            {
                type: "delete",
                primaryKey: 404,
            },
        ]);
        expect(harness.transactions.at(-1)?.collectionMetadata.size).toBe(1);
        expect([...harness.collectionMetadata.values()][0]).toMatchObject({
            version: 1,
            timestamp,
        });

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
            queryFunctionTypes: [],
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
        const baselineCheckpoint = JSON.parse(
            JSON.stringify([...harness.collectionMetadata.values()][0])
        ) as unknown;

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
        expect([...harness.collectionMetadata.values()][0]).toEqual(baselineCheckpoint);
        expect(harness.transactions.at(-1)?.collectionMetadata.size).toBe(0);

        harness.cleanup();
        warnSpy.mockRestore();
    });

    it("fully reconciles after websocket reconnect when edit history is unavailable", async () => {
        const warnSpy = vi.spyOn(
            console,
            "warn"
        ).mockImplementation(() => {});
        mockState.getEditsHistory.mockRejectedValue(
            new Error("Edit history is not enabled")
        );
        mockState.search.mockResolvedValue({
            data: [],
            nextPageToken: undefined,
        });
        const harness = createSyncHarness();

        mockState.subscribeCallback?.({
            type: "state",
            status: "open",
        });
        await vi.waitFor(() => {
            expect(
                mockState.search
            ).toHaveBeenCalledOnce();
        });

        // Simulate stale persisted state becoming visible while the watcher is
        // disconnected and therefore unable to report its deletion.
        harness.syncedData.set(30, {
            employeeId: 30,
            name: "Stale Employee",
        });
        mockState.subscribeCallback?.({
            type: "state",
            status: "open",
        });

        await vi.waitFor(() => {
            expect(mockState.search).toHaveBeenCalledTimes(2);
            expect(
                harness.syncedData.has(30)
            ).toBe(false);
        });
        expect(harness.truncate).toHaveBeenCalled();

        harness.cleanup();
        warnSpy.mockRestore();
    });

    it("does not checkpoint partially fetched history when falling back", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        mockState.getEditsHistory
            .mockResolvedValueOnce({
                data: [
                    {
                        objectPrimaryKey: { employeeId: 20 },
                        operationId: "op-history-20",
                        actionTypeRid: "action-1",
                        userId: "user-1",
                        timestamp: "2099-03-12T12:10:00.000Z",
                        edit: {
                            type: "createEdit",
                            properties: {
                                employeeId: 20,
                                name: "Uncommitted History Employee",
                            },
                        },
                    },
                ],
                nextPageToken: "next",
            })
            .mockRejectedValueOnce(new Error("Edit history pagination failed"));

        const harness = createSyncHarness();
        const baselineCheckpoint = JSON.parse(
            JSON.stringify([...harness.collectionMetadata.values()][0])
        ) as unknown;
        mockState.subscribeCallback?.({
            type: "change",
            updates: [
                {
                    type: "object",
                    state: "ADDED_OR_UPDATED",
                    object: { employeeId: 21, name: "Direct Employee" },
                },
            ],
        });

        await vi.waitFor(() => {
            expect(mockState.getEditsHistory).toHaveBeenCalledTimes(2);
            expect(harness.syncedData.get(21)).toMatchObject({ name: "Direct Employee" });
        });
        expect(harness.syncedData.has(20)).toBe(false);
        expect(harness.writes).toEqual([{ type: "insert", primaryKey: 21 }]);
        expect([...harness.collectionMetadata.values()][0]).toEqual(baselineCheckpoint);

        harness.cleanup();
        warnSpy.mockRestore();
    });

    it("resolves awaitOperationId after direct websocket sync observes an update", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        mockState.getEditsHistory.mockRejectedValue(new Error("Edit history is not enabled"));

        let resolveCommit!: () => void;
        const commitApplied = new Promise<void>((resolve) => {
            resolveCommit = resolve;
        });
        const harness = createSyncHarness([], {
            commitReceipt: () => commitApplied,
        });
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

        resolveCommit();
        await commitApplied;
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

        let resolveCommit!: () => void;
        const commitApplied = new Promise<void>((resolve) => {
            resolveCommit = resolve;
        });
        const harness = createSyncHarness([], {
            commitReceipt: () => commitApplied,
        });

        await expect(harness.utils.awaitOperationId("op-11")).resolves.toBe(true);

        expect(mockState.getEditsHistory).toHaveBeenCalledTimes(1);
        expect(harness.syncedData.get(11)).toEqual({
            employeeId: 11,
            name: "Operation Eleven",
        });

        resolveCommit();
        await commitApplied;
        harness.cleanup();
    });

    it("combines the subset where clause with cursor.whereFrom", async () => {
        mockState.search.mockResolvedValue({
            data: [{ employeeId: 2, status: "open", priority: 6 }],
            nextPageToken: undefined,
        });
        const harness = createSyncHarness();

        await harness.loadSubset({
            where: eq(new IR.PropRef(["status"]), "open"),
            cursor: {
                whereFrom: gt(new IR.PropRef(["priority"]), 5),
                whereCurrent: eq(new IR.PropRef(["priority"]), 5),
            },
        });

        const searchOptions =
            mockState.search.mock.calls[0]?.[3] as
                | {
                      where?: unknown;
                      select?: string[];
                      selectV2?: unknown[];
                  }
                | undefined;
        expect(searchOptions).toMatchObject({
            where: {
                type: "and",
                value: [
                    {
                        type: "eq",
                        propertyIdentifier: { type: "property", apiName: "status" },
                        value: "open",
                    },
                    {
                        type: "gt",
                        propertyIdentifier: { type: "property", apiName: "priority" },
                        value: 5,
                    },
                ],
            },
        });
        expect(searchOptions).toMatchObject({
            select: [
                "employeeId",
                "name",
                "status",
                "priority",
            ],
        });
        expect(searchOptions?.selectV2).toEqual([]);
        expect(harness.syncedData.has(2)).toBe(true);

        harness.cleanup();
    });

    it("over-fetches ordered subsets before applying an offset", async () => {
        mockState.search.mockResolvedValue({
            data: [
                { employeeId: 1, priority: 1 },
                { employeeId: 2, priority: 2 },
                { employeeId: 3, priority: 3 },
                { employeeId: 4, priority: 4 },
            ],
            nextPageToken: undefined,
        });
        const harness = createSyncHarness();

        await harness.loadSubset({
            orderBy: [
                {
                    expression: new IR.PropRef(["priority"]),
                    compareOptions: {
                        direction: "asc",
                        nulls: "last",
                    },
                },
            ],
            offset: 2,
            limit: 2,
        });

        expect(mockState.search.mock.calls[0]?.[3]).toMatchObject({
            pageSize: 4,
            orderBy: {
                fields: [{ field: "priority", direction: "asc" }],
            },
        });
        expect([...harness.syncedData.keys()]).toEqual([3, 4]);

        harness.cleanup();
    });
});
