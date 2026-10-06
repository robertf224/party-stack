import { SingleProcessCoordination, type Coordination } from "@party-stack/coordination";
import {
    SharedWorkerCoordinationClient,
    SharedWorkerCoordinationHost,
    type CoordinationMessagePort,
} from "@party-stack/coordination/shared-worker";
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
                persistence: adapter,
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
            adapter,
            coordination,
        });
        const secondRuntime = coordinatedRuntime({
            adapter,
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
            adapter,
            coordination,
        });
        const second = coordinatedRuntime({
            adapter,
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
                persistence: adapter,
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
                persistence: adapter,
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

describe("persistence coordination", () => {
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

    it("releases cached positions after the last subscription and reloads on reopening", async () => {
        const coordination = new SingleProcessCoordination({ scope: "position-cleanup" });
        const adapter = memoryAdapter();
        const coordinator = createPersistedCollectionCoordinator(coordination, adapter);
        const positions = Reflect.get(coordinator, "positions") as Map<string, unknown>;
        const first = coordinator.subscribe("items", () => {});
        const second = coordinator.subscribe("items", () => {});
        await coordinator.requestApplyLocalMutations!("items", [{ mutationId: "one", type: "insert", key: "one", value: { id: "one" } }]);
        expect(positions.has("items")).toBe(true);
        first();
        first();
        expect(positions.has("items")).toBe(true);
        second();
        expect(positions.has("items")).toBe(false);
        const close = coordinator.subscribe("items", () => {});
        await expect(coordinator.requestApplyLocalMutations!("items", [{ mutationId: "two", type: "insert", key: "two", value: { id: "two" } }])).resolves.toMatchObject({ seq: 2 });
        close();
        expect(positions.size).toBe(0);
        await coordination.close();
    });

    it("delegates pullSince to the runtime adapter and preserves its atomic stream position", async () => {
        const coordination = new SingleProcessCoordination({ scope: "scoped-replay" });
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
        const adapter = { ...memoryAdapter(), pullSince };
        const coordinator = createPersistedCollectionCoordinator(coordination, adapter);
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
