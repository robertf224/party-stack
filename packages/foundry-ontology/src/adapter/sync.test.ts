import { createChannel, createSignal, run, type Signal } from "effection";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectSetSubscriptionMessage } from "@party-stack/foundry-object-set-watcher";
import { createSyncConfig } from "./sync.js";

const mockState = vi.hoisted(() => ({
    getEditsHistory: vi.fn(),
    messages: undefined as Signal<ObjectSetSubscriptionMessage, void> | undefined,
}));

vi.mock("@osdk/foundry.ontologies", () => ({
    ObjectTypesV2: {
        getEditsHistory: mockState.getEditsHistory,
    },
}));

vi.mock("@party-stack/foundry-object-set-watcher/effection", () => ({
    useObjectSetWatcherSubscription: function* () {
        if (!mockState.messages) {
            throw new Error("Subscription stream has not been initialized");
        }
        return yield* mockState.messages;
    },
}));

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function createSyncHarness(initialObjects: Array<Record<string, unknown>> = []) {
    const syncedData = new Map(
        initialObjects.map((object) => [object.employeeId as string | number, object])
    );
    const observedOperationIds: string[] = [];
    const writes: Array<{ type: string; primaryKey: string | number }> = [];
    const operationIds = createChannel<string, void>();
    const operationIdsTask = run(function* () {
        const stream = yield* operationIds;
        while (true) {
            const next = yield* stream.next();
            if (next.done) {
                break;
            }
            observedOperationIds.push(next.value);
        }
    });
    const begin = vi.fn();
    const commit = vi.fn();
    const markReady = vi.fn();

    const sync = createSyncConfig({
        client: {
            baseUrl: "https://example.com",
            fetch: vi.fn(),
            ontologyRid: "ri.ontology.main",
            tokenProvider: () => Promise.resolve("token"),
        } as never,
        objectType: "Employee",
        operationIds,
        primaryKeyProperty: "employeeId",
    });

    const handle = sync.sync({
        begin,
        collection: {
            keys: () => syncedData.keys(),
        } as never,
        commit,
        markReady,
        truncate: vi.fn(),
        write: (mutation: Record<string, unknown>) => {
            const key =
                mutation.type === "delete"
                    ? (mutation as { key: string | number }).key
                    : ((mutation as { value: Record<string, unknown> }).value
                          .employeeId as string | number);
            writes.push({ type: mutation.type as string, primaryKey: key });

            if (mutation.type === "delete") {
                syncedData.delete(key);
                return;
            }

            const value = (mutation as { value: Record<string, unknown> }).value;
            syncedData.set(key, value);
        },
    }) as { cleanup: () => void };

    return {
        begin,
        cleanup: () => {
            handle.cleanup();
            void operationIdsTask.halt();
        },
        commit,
        markReady,
        observedOperationIds,
        syncedData,
        writes,
    };
}

describe("createSyncConfig", () => {
    beforeEach(() => {
        mockState.getEditsHistory.mockReset();
        mockState.messages = createSignal<ObjectSetSubscriptionMessage, void>();
    });

    it("reconciles history after the watcher opens", async () => {
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
        await vi.waitFor(() => expect(harness.markReady).toHaveBeenCalledTimes(1));

        mockState.messages?.send({ type: "state", status: "open" });

        await vi.waitFor(() => {
            expect(mockState.getEditsHistory).toHaveBeenCalledTimes(1);
            expect(harness.syncedData.get(1)).toEqual({
                employeeId: 1,
                name: "Updated Employee",
            });
        });

        harness.cleanup();
    });

    it("runs a follow-up drain when another trigger arrives mid-catch-up", async () => {
        const firstPage = deferred<{ data: Array<Record<string, unknown>>; nextPageToken?: string }>();
        mockState.getEditsHistory
            .mockImplementationOnce(() => firstPage.promise)
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
        await vi.waitFor(() => expect(harness.markReady).toHaveBeenCalledTimes(1));

        mockState.messages?.send({ type: "state", status: "open" });
        await vi.waitFor(() => expect(mockState.getEditsHistory).toHaveBeenCalledTimes(1));

        mockState.messages?.send({ type: "change", updates: [] });
        firstPage.resolve({
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
            expect(harness.writes).toEqual([
                { type: "insert", primaryKey: 1 },
                { type: "insert", primaryKey: 2 },
            ]);
        });

        harness.cleanup();
    });

    it("pushes encountered operation ids into the provided channel", async () => {
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
        await vi.waitFor(() => expect(harness.markReady).toHaveBeenCalledTimes(1));

        mockState.messages?.send({ type: "state", status: "open" });

        await vi.waitFor(() =>
            expect(harness.observedOperationIds).toEqual(["op-11"])
        );

        expect(mockState.getEditsHistory).toHaveBeenCalledTimes(1);
        expect(harness.syncedData.get(11)).toEqual({
            employeeId: 11,
            name: "Operation Eleven",
        });

        harness.cleanup();
    });
});
