import { SingleProcessCoordination, type Coordination } from "@party-stack/coordination";
import {
    SharedWorkerCoordinationClient,
    SharedWorkerCoordinationHost,
    type CoordinationMessagePort,
} from "@party-stack/coordination/shared-worker";
import { SingleProcessCoordinator } from "@tanstack/db-sqlite-persistence-core";
import { describe, expect, it, vi } from "vitest";
import { createPersistedCollectionCoordinator } from "../coordinator/createPersistedCollectionCoordinator.js";
import { MemoryBlobBytesStore } from "../memory/MemoryBlobBytesStore.js";
import { createLocalCollection } from "./createLocalCollection.js";
import type { RuntimeAdapter } from "../types.js";
import type { PersistedTx, PersistenceAdapter } from "@tanstack/db-sqlite-persistence-core";

interface Item {
    id: string;
    title: string;
}

function memoryAdapter(): PersistenceAdapter & {
    getStreamPosition: NonNullable<PersistenceAdapter["getStreamPosition"]>;
} {
    const collections = new Map<string, Map<string | number, Record<string, unknown>>>();
    const positions = new Map<
        string,
        {
            latestTerm: number;
            latestSeq: number;
            latestRowVersion: number;
        }
    >();
    const rows = (collectionId: string) => {
        let collection = collections.get(collectionId);
        if (!collection) {
            collection = new Map();
            collections.set(collectionId, collection);
        }
        return collection;
    };
    return {
        loadResumeSnapshot: (collectionId) =>
            Promise.resolve({
                rows: [...rows(collectionId)].map(([key, value]) => ({ key, value })),
                collectionMetadata: [],
                ...(positions.get(collectionId) ?? { latestTerm: 0, latestSeq: 0, latestRowVersion: 0 }),
                resetEpoch: 0,
            }),
        loadSubset: (collectionId) =>
            Promise.resolve(
                [...rows(collectionId)].map(([key, value]) => ({
                    key,
                    value,
                }))
            ),
        applyCommittedTx: (collectionId: string, transaction: PersistedTx) => {
            const collection = rows(collectionId);
            for (const mutation of transaction.mutations) {
                if (mutation.type === "delete") {
                    collection.delete(mutation.key);
                } else {
                    collection.set(mutation.key, mutation.value);
                }
            }
            positions.set(collectionId, {
                latestTerm: transaction.term,
                latestSeq: transaction.seq,
                latestRowVersion: transaction.rowVersion,
            });
            return Promise.resolve();
        },
        ensureIndex: () => Promise.resolve(),
        getStreamPosition: (collectionId) =>
            Promise.resolve(
                positions.get(collectionId) ?? {
                    latestTerm: 0,
                    latestSeq: 0,
                    latestRowVersion: 0,
                }
            ),
    };
}

function coordinatedRuntime(options: {
    adapter: RuntimeAdapter["persistence"];
    coordination: Coordination;
}): {
    runtime: RuntimeAdapter;
    coordination: Coordination;
} {
    const coordination = options.coordination;
    const runtime: RuntimeAdapter = {
        owner: "test-owner",
        namespace: "test-runtime",
        blobBytes: new MemoryBlobBytesStore(),
        persistence: options.adapter,
        coordination,
    };
    return { runtime, coordination };
}

describe("createLocalCollection", () => {
    it("creates an in-memory collection without runtime persistence", async () => {
        const coordination = new SingleProcessCoordination({
            scope: "memory-items",
        });
        const collection = createLocalCollection<Item, string>({
            name: "memory-items",
            getKey: (item) => item.id,
            runtime: {
                owner: "test-owner",
                namespace: "memory",
                blobBytes: new MemoryBlobBytesStore(),
                coordination,
            },
        });

        await collection.preload();
        const transaction = collection.insert({
            id: "one",
            title: "In memory",
        });
        await transaction.isPersisted.promise;

        expect(collection.get("one")).toMatchObject({
            id: "one",
            title: "In memory",
        });
        await collection.cleanup();
        await coordination.close();
    });

    it("loads through the runtime persistence adapter when available", async () => {
        const loadSubset = vi.fn(() =>
            Promise.resolve([
                {
                    key: "one",
                    value: {
                        id: "one",
                        title: "Persisted",
                    },
                },
            ])
        );
        const loadResumeSnapshot = vi.fn(async () => ({
            rows: await loadSubset(),
            collectionMetadata: [],
            latestTerm: 0,
            latestSeq: 0,
            latestRowVersion: 0,
            resetEpoch: 0,
        }));
        const adapter: PersistenceAdapter = {
            loadResumeSnapshot,
            loadSubset,
            applyCommittedTx: vi.fn(() => Promise.resolve()),
            ensureIndex: vi.fn(() => Promise.resolve()),
        };
        const coordination = new SingleProcessCoordination({
            scope: "persisted-items",
        });
        const collection = createLocalCollection<Item, string>({
            name: "persisted-items",
            getKey: (item) => item.id,
            runtime: {
                owner: "test-owner",
                namespace: "persisted",
                blobBytes: new MemoryBlobBytesStore(),
                persistence: { adapter },
                coordination,
            },
        });

        await collection.preload();

        expect(loadResumeSnapshot).toHaveBeenCalledWith(
            "party-stack:test-owner:persisted:persisted-items",
            expect.any(Object)
        );
        expect(collection.get("one")).toMatchObject({
            id: "one",
            title: "Persisted",
        });
        await collection.cleanup();
        await coordination.close();
    });

    it("propagates committed mutations between coordinated contexts", async () => {
        const adapter = memoryAdapter();
        const coordination = new SingleProcessCoordination({
            scope: "local-collection-test",
        });
        const firstRuntime = coordinatedRuntime({
            adapter: { adapter },
            coordination,
        });
        const secondRuntime = coordinatedRuntime({
            adapter: { adapter },
            coordination,
        });
        const createItems = ({ runtime }: ReturnType<typeof coordinatedRuntime>) =>
            createLocalCollection<Item, string>({
                name: "shared-items",
                getKey: (item) => item.id,
                runtime,
            });
        const first = createItems(firstRuntime);
        const second = createItems(secondRuntime);
        await Promise.all([first.preload(), second.preload()]);
        await second.insert({
            id: "one",
            title: "Shared",
        }).isPersisted.promise;
        await vi.waitFor(() => {
            expect(first.get("one")?.title).toBe("Shared");
            expect(second.get("one")?.title).toBe("Shared");
        });

        await first.cleanup();
        await second.cleanup();
        await coordination.close();
    });

    it("removes non-cloneable subscription and signal state from remote subset requests", async () => {
        const adapter = memoryAdapter();
        const coordination = new SingleProcessCoordination({
            scope: "remote-subset-test",
        });
        const first = coordinatedRuntime({
            adapter: { adapter },
            coordination,
        });
        const second = coordinatedRuntime({
            adapter: { adapter },
            coordination,
        });
        const firstCoordinator = createPersistedCollectionCoordinator(first.coordination, adapter);
        const secondCoordinator = createPersistedCollectionCoordinator(second.coordination, adapter);
        const load = vi.fn((options: unknown) => {
            expect(options).not.toHaveProperty("signal");
            expect(options).not.toHaveProperty("subscription");
            return Promise.resolve();
        });
        const unloadSubset = vi.fn();
        const unregister = firstCoordinator.registerRemoteSubsetOwner(
            "items",
            Object.assign(load, {
                unloadSubset,
                onError: (error: unknown) => {
                    throw error;
                },
            })
        );
        const options = {
            signal: new AbortController().signal,
            subscription: { callback: () => undefined } as never,
        };
        await expect(
            secondCoordinator.requestEnsureRemoteSubset?.("items", options)
        ).resolves.toBeUndefined();
        expect(load).toHaveBeenCalledWith({});
        await secondCoordinator.requestReleaseRemoteSubset("items", options);
        expect(unloadSubset).toHaveBeenCalledWith(load.mock.calls[0]?.[0]);
        unregister();
        await expect(
            firstCoordinator.requestEnsurePersistedIndex("items", "index", {
                expressionSql: [],
            })
        ).resolves.toBeUndefined();

        await coordination.close();
    });

    it("keeps subset acquisitions independent across collections and identical query options", async () => {
        const coordination = new SingleProcessCoordination({ scope: "subset-identities" });
        const coordinator = createPersistedCollectionCoordinator(coordination, memoryAdapter());
        const firstLoad = vi.fn(() => Promise.resolve());
        const secondLoad = vi.fn(() => Promise.resolve());
        const firstUnload = vi.fn();
        const secondUnload = vi.fn();
        const unregisterFirst = coordinator.registerRemoteSubsetOwner("first", Object.assign(firstLoad, { unloadSubset: firstUnload, onError: vi.fn() }));
        const unregisterSecond = coordinator.registerRemoteSubsetOwner("second", Object.assign(secondLoad, { unloadSubset: secondUnload, onError: vi.fn() }));
        const sharedOptions = { limit: 10 };
        const otherOptions = { limit: 10 };
        try {
            await coordinator.requestEnsureRemoteSubset("first", sharedOptions);
            await coordinator.requestEnsureRemoteSubset("second", sharedOptions);
            await coordinator.requestEnsureRemoteSubset("second", otherOptions);
            expect(firstLoad).toHaveBeenCalledTimes(1);
            expect(secondLoad).toHaveBeenCalledTimes(2);
            await coordinator.requestReleaseRemoteSubset("first", sharedOptions);
            expect(firstUnload).toHaveBeenCalledOnce();
            expect(secondUnload).not.toHaveBeenCalled();
            await coordinator.requestReleaseRemoteSubset("second", sharedOptions);
            expect(secondUnload).toHaveBeenCalledTimes(1);
            await coordinator.requestReleaseRemoteSubset("second", otherOptions);
            expect(secondUnload).toHaveBeenCalledTimes(2);
        } finally {
            unregisterFirst();
            unregisterSecond();
            await coordination.close();
        }
    });

    it("releases failed subset leases and permits subsequent loads", async () => {
        const coordination = new SingleProcessCoordination({ scope: "failed-subsets" });
        const coordinator = createPersistedCollectionCoordinator(coordination, memoryAdapter());
        const load = vi.fn<() => Promise<void>>(() => Promise.reject(new Error("load failed")));
        const unloadSubset = vi.fn();
        const onError = vi.fn();
        const unregister = coordinator.registerRemoteSubsetOwner("items", Object.assign(load, { unloadSubset, onError }));
        try {
            for (let index = 0; index < 20; index++) {
                await expect(coordinator.requestEnsureRemoteSubset("items", { limit: index + 1 })).rejects.toThrow("load failed");
            }
            expect(unloadSubset).toHaveBeenCalledTimes(20);
            expect(onError).toHaveBeenCalledTimes(20);
            expect((Reflect.get(coordinator, "remoteAcquisitions") as Map<string, unknown>).size).toBe(0);
            load.mockImplementation(() => Promise.resolve());
            const options = { limit: 50 };
            await coordinator.requestEnsureRemoteSubset("items", options);
            await coordinator.requestReleaseRemoteSubset("items", options);
            expect(unloadSubset).toHaveBeenCalledTimes(21);
        } finally {
            unregister();
            await coordination.close();
        }
    });

    it("bounds host positions for client-only collections and reloads evicted positions from durable storage", async () => {
        const coordination = new SingleProcessCoordination({ scope: "dynamic-host-positions" });
        const adapter = { ...memoryAdapter(), getStreamPosition: undefined };
        const apply = vi.spyOn(adapter, "applyCommittedTx");
        const coordinator = createPersistedCollectionCoordinator(coordination, adapter);
        try {
            for (let index = 0; index < 160; index++) {
                await coordinator.requestApplyLocalMutations!(`client-${index}`, [{ mutationId: "one", type: "insert", key: "one", value: { id: "one" } }]);
            }
            expect((Reflect.get(coordinator, "positions") as Map<string, unknown>).size).toBeLessThanOrEqual(128);
            await coordinator.requestApplyLocalMutations!("client-0", [{ mutationId: "two", type: "insert", key: "two", value: { id: "two" } }]);
            expect(apply).toHaveBeenLastCalledWith("client-0", expect.objectContaining({ seq: 2, rowVersion: 2 }));
        } finally {
            await coordination.close();
        }
    });

    it("routes client-only persistence through a SharedWorker host", async () => {
        const adapter = memoryAdapter();
        const channel = new MessageChannel();
        const hostCoordination = new SharedWorkerCoordinationHost({
            scope: "shared-worker-persistence",
        });
        const disconnect = hostCoordination.connect(channel.port1 as unknown as CoordinationMessagePort);
        const clientCoordination = new SharedWorkerCoordinationClient({
            scope: "shared-worker-persistence",
            worker: channel.port2 as unknown as CoordinationMessagePort,
        });
        const host = createLocalCollection<Item, string>({
            name: "worker-items",
            getKey: (item) => item.id,
            runtime: {
                owner: "test-owner",
                namespace: "worker",
                blobBytes: new MemoryBlobBytesStore(),
                persistence: { adapter },
                coordination: hostCoordination,
            },
        });
        const client = createLocalCollection<Item, string>({
            name: "worker-items",
            getKey: (item) => item.id,
            runtime: {
                owner: "test-owner",
                namespace: "worker",
                blobBytes: new MemoryBlobBytesStore(),
                persistence: { adapter },
                coordination: clientCoordination,
            },
        });
        await Promise.all([host.preload(), client.preload()]);

        await client.insert({
            id: "one",
            title: "From client",
        }).isPersisted.promise;

        await vi.waitFor(() => {
            expect(host.get("one")?.title).toBe("From client");
            expect(client.get("one")?.title).toBe("From client");
        });
        expect(clientCoordination.role).toBe("client");

        const coordinator = createPersistedCollectionCoordinator(clientCoordination, adapter);
        const collectionId = "party-stack:test-owner:worker:worker-items";
        await expect(
            coordinator.requestApplyCommittedTx(collectionId, {
                txId: "source-commit",
                term: 1,
                seq: 2,
                rowVersion: 2,
                mutations: [{ type: "insert", key: "two", value: { id: "two", title: "From source" } }],
            })
        ).resolves.toMatchObject({ ok: true, latestRowVersion: 2 });
        expect(await adapter.loadSubset(collectionId, {})).toEqual(
            expect.arrayContaining([{ key: "two", value: { id: "two", title: "From source" } }])
        );

        await client.cleanup();
        await host.cleanup();
        await clientCoordination.close();
        disconnect();
        await hostCoordination.close();
    });
});

describe("collection-scoped persistence", () => {
    it("forwards local mode and schema and routes writes through the scoped adapter", async () => {
        const coordination = new SingleProcessCoordination({ scope: "scoped-persistence" });
        const scoped = { ...memoryAdapter(), schemaVersion: 2 };
        const apply = vi.spyOn(scoped, "applyCommittedTx");
        const root = memoryAdapter();
        const coordinator = createPersistedCollectionCoordinator(coordination, root);
        const registerAdapter = vi.spyOn(coordinator, "setAdapterForCollection");
        const scopedPosition = vi.spyOn(scoped, "getStreamPosition");
        const rootPosition = vi.spyOn(root, "getStreamPosition");
        const defaultCoordinator = new SingleProcessCoordinator();
        const defaultApply = vi.spyOn(defaultCoordinator, "requestApplyCommittedTx");
        const resolvePersistenceForCollection = vi.fn(() => ({
            adapter: scoped,
            coordinator: defaultCoordinator,
        }));
        const rootApply = vi.spyOn(root, "applyCommittedTx");
        const collection = createLocalCollection<Item, string>({
            name: "scoped",
            schemaVersion: 2,
            getKey: (item) => item.id,
            runtime: coordinatedRuntime({
                adapter: { adapter: root, resolvePersistenceForCollection },
                coordination,
            }).runtime,
        });
        await collection.preload();
        expect(registerAdapter).toHaveBeenCalledExactlyOnceWith(collection.id, scoped);
        expect(resolvePersistenceForCollection).toHaveBeenCalledWith({
            collectionId: collection.id,
            mode: "sync-absent",
            schemaVersion: 2,
        });
        await collection.insert({ id: "one", title: "Scoped" }).isPersisted.promise;
        expect(apply).toHaveBeenCalled();
        expect(rootApply).not.toHaveBeenCalled();
        expect(defaultApply).not.toHaveBeenCalled();
        await collection.cleanup();
        scopedPosition.mockClear();
        rootPosition.mockClear();
        await coordinator.pullSince!(collection.id, 0);
        expect(scopedPosition).not.toHaveBeenCalled();
        expect(rootPosition).toHaveBeenCalledWith(collection.id);
        await coordination.close();
    });

    it("keeps different collection versions isolated on one shared coordinator", async () => {
        const coordination = new SingleProcessCoordination({ scope: "different-schemas" });
        const root = memoryAdapter();
        const tasksAdapter = { ...memoryAdapter(), schemaVersion: 2 };
        const settingsAdapter = { ...memoryAdapter(), schemaVersion: 7 };
        const rootApply = vi.spyOn(root, "applyCommittedTx");
        const tasksApply = vi.spyOn(tasksAdapter, "applyCommittedTx");
        const settingsApply = vi.spyOn(settingsAdapter, "applyCommittedTx");
        const runtime = coordinatedRuntime({
            adapter: {
                adapter: root,
                resolvePersistenceForCollection: ({ schemaVersion }) => ({
                    adapter: schemaVersion === 2 ? tasksAdapter : settingsAdapter,
                }),
            },
            coordination,
        }).runtime;
        const tasks = createLocalCollection<Item, string>({
            name: "tasks",
            schemaVersion: 2,
            runtime,
            getKey: (item) => item.id,
        });
        const settings = createLocalCollection<Item, string>({
            name: "settings",
            schemaVersion: 7,
            runtime,
            getKey: (item) => item.id,
        });
        await Promise.all([tasks.preload(), settings.preload()]);
        await tasks.insert({ id: "one", title: "Task" }).isPersisted.promise;
        await settings.insert({ id: "one", title: "Setting" }).isPersisted.promise;
        expect(tasksApply).toHaveBeenCalledWith(tasks.id, expect.anything());
        expect(settingsApply).toHaveBeenCalledWith(settings.id, expect.anything());
        expect(rootApply).not.toHaveBeenCalled();
        await tasks.cleanup();
        await settings.insert({ id: "two", title: "Still active" }).isPersisted.promise;
        expect(settings.get("two")?.title).toBe("Still active");
        expect(createPersistedCollectionCoordinator(coordination, root)).toBe(
            createPersistedCollectionCoordinator(coordination, root)
        );
        await settings.cleanup();
        await coordination.close();
    });

    it("preserves row metadata in local mutation RPC and broadcasts", async () => {
        const coordination = new SingleProcessCoordination({ scope: "mutation-metadata" });
        const adapter = memoryAdapter();
        const apply = vi.spyOn(adapter, "applyCommittedTx");
        const coordinator = createPersistedCollectionCoordinator(coordination, adapter);
        const listener = vi.fn();
        const unsubscribe = coordinator.subscribe("items", listener);
        await coordinator.requestApplyLocalMutations!("items", [
            {
                mutationId: "insert",
                type: "insert",
                key: "one",
                value: { id: "one" },
                metadata: { etag: "v1" },
                metadataChanged: true,
            },
        ]);
        expect(apply).toHaveBeenCalledWith(
            "items",
            expect.objectContaining({
                mutations: [
                    {
                        type: "insert",
                        key: "one",
                        value: { id: "one" },
                        metadata: { etag: "v1" },
                        metadataChanged: true,
                    },
                ],
            })
        );
        const broadcast: unknown = listener.mock.calls[0]?.[0];
        expect(broadcast).toMatchObject({
            payload: {
                rowMetadataMutations: [{ type: "set", key: "one", value: { etag: "v1" } }],
            },
        });
        unsubscribe();
        await coordination.close();
    });

    it("does not advance the persisted sequence or publish success when a write fails", async () => {
        const coordination = new SingleProcessCoordination({ scope: "failed-persistence" });
        const adapter = memoryAdapter();
        const write = adapter.applyCommittedTx;
        const apply = vi
            .spyOn(adapter, "applyCommittedTx")
            .mockRejectedValueOnce(new Error("disk full"))
            .mockImplementation(write);
        const coordinator = createPersistedCollectionCoordinator(coordination, adapter);
        const listener = vi.fn();
        const unsubscribe = coordinator.subscribe("items", listener);
        await expect(
            coordinator.requestApplyLocalMutations!("items", [
                { mutationId: "first", type: "insert", key: "one", value: { id: "one" } },
            ])
        ).rejects.toThrow("disk full");
        expect(listener).not.toHaveBeenCalled();
        await expect(
            coordinator.requestApplyLocalMutations!("items", [
                { mutationId: "second", type: "insert", key: "two", value: { id: "two" } },
            ])
        ).resolves.toMatchObject({ seq: 1, latestRowVersion: 1 });
        expect(apply).toHaveBeenCalledTimes(2);
        unsubscribe();
        await coordination.close();
    });

    it("keeps a scoped adapter until its last subscription closes and supports reopening", async () => {
        const coordination = new SingleProcessCoordination({ scope: "scoped-cleanup" });
        const root = memoryAdapter();
        const rootPosition = vi.spyOn(root, "getStreamPosition");
        const scoped = memoryAdapter();
        const scopedPosition = vi.spyOn(scoped, "getStreamPosition");
        const coordinator = createPersistedCollectionCoordinator(coordination, root);
        coordinator.setAdapterForCollection!("items", scoped);
        const first = coordinator.subscribe("items", () => {});
        const second = coordinator.subscribe("items", () => {});
        first();
        first();
        await coordinator.pullSince!("items", 0);
        expect(scopedPosition).toHaveBeenCalled();
        expect(rootPosition).not.toHaveBeenCalled();
        second();
        scopedPosition.mockClear();
        await coordinator.pullSince!("items", 0);
        expect(scopedPosition).not.toHaveBeenCalled();
        expect(rootPosition).toHaveBeenCalled();
        const reopened = memoryAdapter();
        const reopenedPosition = vi.spyOn(reopened, "getStreamPosition");
        coordinator.setAdapterForCollection!("items", reopened);
        const close = coordinator.subscribe("items", () => {});
        await coordinator.pullSince!("items", 0);
        expect(reopenedPosition).toHaveBeenCalled();
        close();
        await coordination.close();
    });

    it("routes pullSince to the scoped adapter and preserves its atomic stream position", async () => {
        const coordination = new SingleProcessCoordination({ scope: "scoped-replay" });
        const root = memoryAdapter();
        const coordinator = createPersistedCollectionCoordinator(coordination, root);
        const pullSince = vi.fn(() =>
            Promise.resolve({
                latestTerm: 5,
                latestSeq: 7,
                latestRowVersion: 9,
                requiresFullReload: false as const,
                changedKeys: ["one"],
                deletedKeys: [],
                deltas: [],
            })
        );
        const scoped = { ...memoryAdapter(), pullSince };
        coordinator.setAdapterForCollection!("items", scoped);
        expect(await coordinator.pullSince!("items", 8)).toMatchObject({
            latestTerm: 5,
            latestSeq: 7,
            latestRowVersion: 9,
            requiresFullReload: false,
            changedKeys: ["one"],
        });
        expect(pullSince).toHaveBeenCalledWith("items", 8);
        await coordination.close();
    });
});

describe("worker schema fencing", () => {
    it("rejects stale-schema worker writes and index requests", async () => {
        const channel = new MessageChannel();
        const hostCoordination = new SharedWorkerCoordinationHost({ scope: "schema-fencing" });
        const disconnect = hostCoordination.connect(channel.port1 as unknown as CoordinationMessagePort);
        const clientCoordination = new SharedWorkerCoordinationClient({
            scope: "schema-fencing",
            worker: channel.port2 as unknown as CoordinationMessagePort,
        });
        const current = { ...memoryAdapter(), schemaVersion: 2 };
        const stale = { ...memoryAdapter(), schemaVersion: 1 };
        const apply = vi.spyOn(current, "applyCommittedTx");
        const ensure = vi.spyOn(current, "ensureIndex");
        const host = createPersistedCollectionCoordinator(hostCoordination, current);
        const client = createPersistedCollectionCoordinator(clientCoordination, stale);
        host.setAdapterForCollection!("items", current);
        client.setAdapterForCollection!("items", stale);
        try {
            await expect(
                client.requestApplyLocalMutations!("items", [
                    { mutationId: "old-insert", type: "insert", key: "one", value: { id: "one" } },
                ])
            ).rejects.toThrow("schema mismatch");
            await expect(
                client.requestApplyCommittedTx(
                    "items",
                    { txId: "stale", term: 1, seq: 1, rowVersion: 1, mutations: [] },
                    stale
                )
            ).rejects.toThrow("schema mismatch");
            await expect(
                client.requestEnsurePersistedIndex(
                    "items",
                    "index",
                    { expressionSql: [JSON.stringify({ type: "ref", path: ["id"] })] },
                    stale
                )
            ).rejects.toThrow("schema mismatch");
            expect(apply).not.toHaveBeenCalled();
            expect(ensure).not.toHaveBeenCalled();
        } finally {
            await clientCoordination.close();
            disconnect();
            await hostCoordination.close();
        }
    });
});
