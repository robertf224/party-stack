import {
    SingleProcessCoordination,
    type Coordination,
} from "@party-stack/coordination";
import {
    SharedWorkerCoordinationClient,
    SharedWorkerCoordinationHost,
    type CoordinationMessagePort,
} from "@party-stack/coordination/shared-worker";
import {
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { createPersistedCollectionCoordinator } from "../coordinator/createPersistedCollectionCoordinator.js";
import { MemoryBlobBytesStore } from "../memory/MemoryBlobBytesStore.js";
import { createLocalCollection } from "./createLocalCollection.js";
import type { RuntimeAdapter } from "../types.js";
import type { PersistedTx, PersistenceAdapter } from "@tanstack/db-sqlite-persistence-core";

interface Item {
    id: string;
    title: string;
}

function memoryAdapter(): PersistenceAdapter {
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
    adapter: PersistenceAdapter;
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
        const coordination =
            new SingleProcessCoordination({
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
        const adapter: PersistenceAdapter = {
            loadSubset,
            applyCommittedTx: vi.fn(() => Promise.resolve()),
            ensureIndex: vi.fn(() => Promise.resolve()),
        };
        const coordination =
            new SingleProcessCoordination({
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

        expect(loadSubset).toHaveBeenCalledWith(
            "party-stack:test-owner:persisted:persisted-items",
            expect.any(Object),
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
        const coordination =
            new SingleProcessCoordination({
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

    it("removes non-cloneable subscription state from remote subset requests", async () => {
        const adapter = memoryAdapter();
        const coordination =
            new SingleProcessCoordination({
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
        const firstCoordinator =
            createPersistedCollectionCoordinator(
                first.coordination,
                adapter
            );
        const secondCoordinator =
            createPersistedCollectionCoordinator(
                second.coordination,
                adapter
            );
        await expect(
            secondCoordinator.requestEnsureRemoteSubset?.(
                "items",
                {
                    subscription: {
                        callback: () => undefined,
                    } as never,
                }
            )
        ).resolves.toBeUndefined();
        await expect(
            firstCoordinator.requestEnsurePersistedIndex(
                "items",
                "index",
                {
                    expressionSql: [],
                }
            )
        ).resolves.toBeUndefined();

        await coordination.close();
    });

    it("routes client-only persistence through a SharedWorker host", async () => {
        const adapter = memoryAdapter();
        const channel = new MessageChannel();
        const hostCoordination =
            new SharedWorkerCoordinationHost({
                scope: "shared-worker-persistence",
            });
        const disconnect = hostCoordination.connect(
            channel.port1 as unknown as CoordinationMessagePort
        );
        const clientCoordination =
            new SharedWorkerCoordinationClient({
                scope: "shared-worker-persistence",
                worker:
                    channel.port2 as unknown as CoordinationMessagePort,
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
        await Promise.all([
            host.preload(),
            client.preload(),
        ]);

        await client.insert({
            id: "one",
            title: "From client",
        }).isPersisted.promise;

        await vi.waitFor(() => {
            expect(host.get("one")?.title).toBe(
                "From client"
            );
            expect(client.get("one")?.title).toBe(
                "From client"
            );
        });
        expect(clientCoordination.role).toBe("client");

        await client.cleanup();
        await host.cleanup();
        await clientCoordination.close();
        disconnect();
        await hostCoordination.close();
    });
});
