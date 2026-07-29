import {
    MemoryBlobBytesStore,
    SingleProcessCoordination,
    type BlobBytesStore,
    type Coordination,
    type CoordinationService,
    type RuntimeAdapter,
} from "@party-stack/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    BLOB_COORDINATION_SERVICE,
    type BlobCoordinationService,
} from "./store/createBlobStore.js";
import { createBlobManager } from "./index.js";
import type {
    BlobManagerOptions,
    BlobRemoteSource,
} from "./types.js";

const unexpectedRemote: BlobRemoteSource = {
    metadata: (id) =>
        Promise.resolve({
            id,
            size: 0,
            type: "",
            name: "",
        }),
    read: () =>
        Promise.reject(new Error("unexpected remote blob read")),
};

function setup(
    options: Partial<BlobManagerOptions> & {
        bytes?: BlobBytesStore;
        coordination?: Coordination;
        remote?: BlobRemoteSource;
    } = {}
) {
    const bytes = options.bytes ?? new MemoryBlobBytesStore();
    const coordination =
        options.runtime?.coordination ??
        options.coordination ??
        new SingleProcessCoordination({
            scope: "blob-manager-test",
        });
    const runtime: RuntimeAdapter = options.runtime ?? {
        owner: "user-1",
        namespace: "ontology-1",
        blobBytes: bytes,
        coordination,
    };
    const manager = createBlobManager({
        runtime,
        remote: options.remote ?? unexpectedRemote,
        gcTime: options.gcTime,
    });
    return { bytes, coordination, manager, runtime };
}

function asClient(
    coordination: Coordination
): Coordination {
    return {
        role: "client",
        service<Service extends CoordinationService>(
            namespace: string
        ) {
            return coordination.service<Service>(namespace);
        },
        close: () => Promise.resolve(),
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("createBlobManager", () => {
    it("stages bytes and serves their metadata", async () => {
        vi.spyOn(Date, "now").mockReturnValue(100);
        const { bytes, manager } = setup();

        const ref = await manager.stage(
            "attachment-1",
            new File(["hello"], "hello.txt", {
                type: "text/plain",
            })
        );

        expect(ref).toMatchObject({
            id: "attachment-1",
            name: "hello.txt",
            size: 5,
            state: "staged",
            createdAt: 100,
        });
        expect(
            manager.collection.get("attachment-1")
        ).toMatchObject({
            id: "attachment-1",
            state: "staged",
        });
        expect("stage" in manager.collection.utils).toBe(false);
        await expect(
            manager.metadata("attachment-1")
        ).resolves.toEqual({
            id: "attachment-1",
            name: "hello.txt",
            size: 5,
            type: "text/plain",
        });
        await expect(
            bytes.read("attachment-1")
        ).resolves.toBeInstanceOf(Blob);
        await manager.cleanup();
    });

    it("records byte write failures without hiding them", async () => {
        const bytes: BlobBytesStore = {
            write: () => Promise.reject(new Error("disk full")),
            read: () => Promise.reject(new Error("missing")),
            delete: () => Promise.resolve(),
        };
        const { manager } = setup({ bytes });

        await expect(
            manager.stage("attachment-1", new Blob(["hello"]))
        ).rejects.toThrow("disk full");
        await expect(
            manager.metadata("attachment-1")
        ).resolves.toMatchObject({
            id: "attachment-1",
            size: 5,
        });
        await manager.cleanup();
    });

    it("pulls remote bytes through the local cache", async () => {
        let reads = 0;
        const remoteBlob = new Blob(["remote"], {
            type: "text/plain",
        });
        const { manager } = setup({
            remote: {
                metadata: (id) =>
                    Promise.resolve({
                        id,
                        size: 6,
                        type: "text/plain",
                        name: "remote.txt",
                    }),
                read: () => {
                    reads += 1;
                    return Promise.resolve(remoteBlob);
                },
            },
        });

        await expect(manager.read("remote-id")).resolves.toBe(
            remoteBlob
        );
        await expect(
            manager.read("remote-id").then((blob) => blob.text())
        ).resolves.toBe("remote");
        expect(reads).toBe(1);
        await manager.cleanup();
    });

    it("resolves remote ids to locally staged bytes", async () => {
        const { manager } = setup();
        await manager.stage(
            "local-id",
            new Blob(["hello"], { type: "text/plain" })
        );
        await manager.bindRemoteId("local-id", "remote-id");

        await expect(
            manager.read("remote-id").then((blob) => blob.text())
        ).resolves.toBe("hello");
        await manager.cleanup();
    });

    it("does not remote-fetch missing local-only staged bytes", async () => {
        const remoteBlob = vi.fn(() =>
            Promise.resolve(new Blob(["unexpected"]))
        );
        const { bytes, manager } = setup({
            remote: {
                metadata: unexpectedRemote.metadata,
                read: remoteBlob,
            },
        });
        await manager.stage("local-id", new Blob(["hello"]));
        await bytes.delete("local-id");

        await expect(manager.read("local-id")).rejects.toThrow(
            'Blob bytes are unavailable for "local-id".'
        );
        expect(remoteBlob).not.toHaveBeenCalled();
        await manager.cleanup();
    });

    it("runs GC over queried metadata candidates", async () => {
        let reads = 0;
        const { bytes, manager } = setup({
            remote: {
                metadata: (id) =>
                    Promise.resolve({
                        id,
                        size: 6,
                        type: "text/plain",
                        name: "remote.txt",
                    }),
                read: () => {
                    reads += 1;
                    return Promise.resolve(
                        new Blob(["remote"], {
                            type: "text/plain",
                        })
                    );
                },
            },
            gcTime: 0,
        });

        await manager.read("remote-id");
        await vi.waitFor(async () => {
            await expect(
                bytes.read("remote-id")
            ).rejects.toThrow("not found");
        });
        await manager.read("remote-id");
        await vi.waitFor(async () => {
            await expect(
                bytes.read("remote-id")
            ).rejects.toThrow("not found");
        });
        expect(reads).toBe(2);
        await manager.cleanup();
    });

    it("coordinates client-only writes through the host service", async () => {
        const bytes = new MemoryBlobBytesStore();
        const coordination = new SingleProcessCoordination({
            scope: "coordinated-blob-clients",
        });
        const host = setup({
            bytes,
            coordination,
        }).manager;
        const client = setup({
            bytes,
            coordination: asClient(coordination),
        }).manager;

        await expect(
            client.stage(
                "local-id",
                new File(["hello"], "hello.txt", {
                    type: "text/plain",
                })
            )
        ).resolves.toMatchObject({
            id: "local-id",
            state: "staged",
        });
        await expect(
            host.metadata("local-id")
        ).resolves.toMatchObject({
            id: "local-id",
            name: "hello.txt",
            size: 5,
        });
        await client.bindRemoteId("local-id", "remote-id");
        await expect(
            host.read("remote-id").then((blob) => blob.text())
        ).resolves.toBe("hello");

        await client.cleanup();
        await host.cleanup();
        await coordination.close();
    });

    it("wakes GC only on the coordination leader", async () => {
        const bytes = new MemoryBlobBytesStore();
        const coordination = new SingleProcessCoordination({
            scope: "leader-only-blob-gc",
        });
        const host = setup({
            bytes,
            coordination,
            gcTime: 0,
        }).manager;
        const client = setup({
            bytes,
            coordination: asClient(coordination),
            remote: {
                metadata: (id) =>
                    Promise.resolve({
                        id,
                        size: 6,
                        type: "text/plain",
                        name: "remote.txt",
                    }),
                read: () =>
                    Promise.resolve(
                        new Blob(["remote"], {
                            type: "text/plain",
                        })
                    ),
            },
            gcTime: 0,
        }).manager;

        await client.read("remote-id");
        await vi.waitFor(async () => {
            await expect(
                bytes.read("remote-id")
            ).rejects.toThrow("not found");
        });

        await client.cleanup();
        await host.cleanup();
        await coordination.close();
    });

    it("cancels leader work and closes handlers during cleanup", async () => {
        const coordination = new SingleProcessCoordination({
            scope: "blob-cleanup",
        });
        const { manager } = setup({
            coordination,
            remote: {
                metadata: (id) =>
                    Promise.resolve({
                        id,
                        size: 6,
                        type: "text/plain",
                        name: "remote.txt",
                    }),
                read: () =>
                    Promise.resolve(new Blob(["remote"])),
            },
        });

        await manager.read("remote-id");
        await expect(manager.cleanup()).resolves.toBeUndefined();
        await expect(
            coordination
                .service<BlobCoordinationService>(
                    BLOB_COORDINATION_SERVICE
                )
                .methods.find({ id: "remote-id" })
        ).rejects.toMatchObject({
            code: "SERVICE_UNAVAILABLE",
        });
        await coordination.close();
    });
});
