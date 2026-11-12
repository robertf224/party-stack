import { createHash } from "node:crypto";
import { Table } from "@party-stack/ontology-storage/tables";
import { Runtime, Runtimes, collectByteBlob } from "@party-stack/runtime";
import { RuntimePartition } from "@party-stack/runtime";
import { acquireRuntime } from "@party-stack/runtime/testing";
import { runtimeFixtureContext } from "@party-stack/runtime/testing";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { make, expoRuntime, layer as platformLayer } from "./index.js";
const createExpoRuntime = (owner: string, namespace: string) =>
    make().pipe(Effect.provideService(RuntimePartition, { owner, namespace }));
const layer = (partition: { owner: string; namespace: string }) =>
    platformLayer().pipe(Layer.provide(Layer.succeed(RuntimePartition)(partition)));

const state = vi.hoisted(() => ({
    events: [] as string[],
    close: vi.fn(),
    delete: vi.fn(),
    open: vi.fn(),
    disconnect: vi.fn(),
    clear: vi.fn(),
    directory: vi.fn(),
    secrets: vi.fn(),
    authenticate: vi.fn(),
    generateKey: vi.fn(() => Promise.resolve("native-key")),
    importKey: vi.fn(() =>
        Promise.resolve({
            encrypt: async (bytes: Uint8Array) => bytes,
            decrypt: async (bytes: Uint8Array) => bytes,
        })
    ),
    availableDiskSpace: 4096,
}));
vi.mock("expo-file-system", () => ({
    Paths: {
        totalDiskSpace: 16384,
        get availableDiskSpace() {
            return state.availableDiskSpace;
        },
    },
}));
vi.mock("expo-crypto", () => ({
    CryptoDigestAlgorithm: { SHA256: "SHA-256" },
    digest: (_algorithm: string, bytes: Uint8Array) =>
        Promise.resolve(createHash("sha256").update(bytes).digest()),
    digestStringAsync: (_algorithm: string, value: string) =>
        Promise.resolve(createHash("sha256").update(value).digest("hex")),
}));
vi.mock("expo-sqlite", () => ({ openDatabaseAsync: state.open, deleteDatabaseAsync: state.delete }));
vi.mock("./ExpoNetworkConnectivity.js", () => ({
    makeExpoNetworkConnectivity: () =>
        Effect.acquireRelease(
            Effect.succeed({ online: Effect.succeed(true), changes: Stream.make(true) }),
            () => Effect.sync(state.disconnect)
        ),
}));
vi.mock("./ExpoFileSystemBlobBytesStore.js", () => ({
    ExpoFileSystemBlobBytesStore: class {
        constructor(options: unknown) {
            state.directory(options);
        }
        clear = () => Effect.sync(state.clear);
    },
}));
vi.mock("./encryptionKeys.js", () => ({
    nativeKeyCodec: { generate: state.generateKey, import: state.importKey },
}));
vi.mock("./ExpoKeyMaterialStore.js", () => ({ makeKeyMaterialStore: state.secrets }));
vi.mock("./createExpoBrowserAuthentication.js", () => ({
    createExpoBrowserAuthentication: () => ({ start: state.authenticate }),
}));

describe("createExpoRuntime", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        state.events = [];
        state.secrets.mockReturnValue({});
        state.authenticate.mockImplementation(() =>
            Effect.succeed({ open: () => Effect.succeed({ callbackUrl: "notes://callback" }) })
        );
        state.close.mockImplementation(async () => {
            await Promise.resolve();
            state.events.push("closed");
        });
        state.delete.mockImplementation(() => {
            state.events.push("deleted");
            return Promise.resolve();
        });
        state.open.mockResolvedValue({
            closeAsync: state.close,
            execSync: vi.fn(),
            getAllSync: vi.fn(() => []),
            runSync: vi.fn(),
        });
    });

    it("reports live device storage capacity without inventing available memory", async () => {
        const runtime = await acquireRuntime(createExpoRuntime("owner", "capacity"));
        try {
            const native = await runtimeFixtureContext(runtime).runtime.runPromise(Runtime);
            expect(await Effect.runPromise(native.capacity!.memory)).toBeUndefined();
            state.availableDiskSpace = 4096;
            expect(await Effect.runPromise(native.capacity!.storage)).toEqual({
                scope: "filesystem",
                limitBytes: 16384,
                availableBytes: 4096,
            });
            state.availableDiskSpace = 2048;
            expect((await Effect.runPromise(native.capacity!.storage))?.availableBytes).toBe(2048);
        } finally {
            await runtime.cleanup?.();
        }
    });

    it("hashes logical partition names into bounded filesystem names without ambiguous separators", async () => {
        const owner = "../user@example.com/".repeat(100);
        const runtime = await acquireRuntime(createExpoRuntime(owner, "namespace"));
        expect(runtime.owner).toBe(owner);
        const name = `party-stack-${createHash("sha256")
            .update(JSON.stringify([owner, "namespace"]))
            .digest("hex")}`;
        await runtimeFixtureContext(runtime).runtime.runPromise(Runtime);
        expect(state.open).toHaveBeenCalledWith(`${name}-storage.db`);
        expect(state.directory).toHaveBeenCalledWith({ directoryName: `${name}-blobs` });
        await runtime.cleanup?.();
        const a = await acquireRuntime(createExpoRuntime("a:b", "c"));
        const b = await acquireRuntime(createExpoRuntime("a", "b:c"));
        await runtimeFixtureContext(a).runtime.runPromise(Runtime);
        await runtimeFixtureContext(b).runtime.runPromise(Runtime);
        expect(state.open.mock.calls[1]?.[0]).not.toBe(state.open.mock.calls[2]?.[0]);
        await a.cleanup?.();
        await b.cleanup?.();
    });

    it.each([false, true])(
        "closes before deleting and makes cleanup/destroy idempotent (cleanup first: %s)",
        async (cleanupFirst) => {
            const runtime = await acquireRuntime(createExpoRuntime("owner", "namespace"));
            await runtimeFixtureContext(runtime).runtime.runPromise(Runtime);
            if (cleanupFirst) await runtime.cleanup?.();
            await Promise.all([runtime.destroy?.(), runtime.cleanup?.(), runtime.destroy?.()]);
            expect(state.close).toHaveBeenCalledTimes(1);
            expect(state.disconnect).toHaveBeenCalledTimes(1);
            expect(state.delete).toHaveBeenCalledTimes(1);
            expect(state.clear).toHaveBeenCalledTimes(1);
            expect(state.events).toEqual(["closed", "deleted"]);
        }
    );

    it("does not delete the database if closing it fails", async () => {
        state.close.mockRejectedValue(new Error("close failed"));
        const runtime = await acquireRuntime(createExpoRuntime("owner", "namespace"));
        await runtimeFixtureContext(runtime).runtime.runPromise(Runtime);
        await expect(runtime.destroy?.()).rejects.toThrow("close failed");
        expect(state.delete).not.toHaveBeenCalled();
    });

    it("is lazy and releases the database and native listener on fiber interruption", async () => {
        const acquire = make().pipe(
            Effect.provideService(RuntimePartition, { owner: "test", namespace: "scope" })
        );
        const opens = state.open.mock.calls.length;
        expect(state.open.mock.calls.length).toBe(opens);
        await Effect.runPromise(
            Effect.gen(function* () {
                const ready = yield* Deferred.make<void>();
                const fiber = yield* Effect.forkChild(
                    Effect.gen(function* () {
                        yield* Runtime;
                        yield* Deferred.succeed(ready, undefined);
                        yield* Effect.never;
                    }).pipe(Effect.provide(layer({ owner: "test", namespace: "scope" })))
                );
                yield* Deferred.await(ready);
                yield* Fiber.interrupt(fiber);
            })
        );
        expect(state.open.mock.calls.length).toBe(opens + 1);
        expect(state.close).toHaveBeenCalledOnce();
        expect(state.disconnect).toHaveBeenCalledOnce();
        expect(Effect.isEffect(acquire)).toBe(true);
    });

    it("releases the connectivity subscription if database acquisition fails", async () => {
        state.open.mockRejectedValueOnce(new Error("storage denied"));
        await Effect.runPromise(
            Effect.result(
                Effect.scoped(
                    make().pipe(
                        Effect.provideService(RuntimePartition, { owner: "test", namespace: "denied" })
                    )
                )
            )
        );
        expect(state.disconnect).toHaveBeenCalledOnce();
        expect(state.close).not.toHaveBeenCalled();
    });
});

it("public memory runtime retains native capabilities without acquiring persistent storage", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const runtimes = yield* Runtimes;
                expect(state.open).not.toHaveBeenCalled();
                expect(state.directory).not.toHaveBeenCalled();
                const authentication = yield* runtimes.browserAuthentication!.start({
                    redirectUrl: "notes://callback",
                });
                expect(yield* authentication.open("https://example.com/oauth")).toEqual({
                    callbackUrl: "notes://callback",
                });
                const first = yield* runtimes.acquire({ owner: "device", namespace: "connect" });
                const same = yield* runtimes.acquire({ owner: "device", namespace: "connect" });
                const other = yield* runtimes.acquire({ owner: "device", namespace: "notes" });
                expect(first).toBe(same);
                expect(yield* first.connectivity.online).toBe(true);
                expect(first.browserAuthentication).toBeDefined();
                expect(first.encryptionKeyring).toBeDefined();
                const active = yield* first.encryptionKeyring!.active;
                expect((yield* first.encryptionKeyring!.active).id).toBe(active.id);
                expect(yield* first.encryptionKeyring!.get(active.id)).toBeDefined();
                expect(yield* other.encryptionKeyring!.get(active.id)).toBeUndefined();
                expect(state.generateKey).toHaveBeenCalledOnce();
                expect(yield* first.capacity!.storage).toBeUndefined();
                const table = Table.make<{ title: string }>({ name: "memory-runtime-probe" });
                yield* first.tables.put(table, "one", { title: "Local" });
                expect(yield* first.tables.get(table, "one")).toEqual({ title: "Local" });
                expect(yield* other.tables.get(table, "one")).toBeUndefined();
                yield* first.bytes.write("file", new Blob(["memory attachment"]));
                const bytes = yield* first.bytes.read("file");
                if (!bytes) return yield* Effect.die("Missing memory attachment");
                const blob = yield* collectByteBlob(bytes);
                expect(yield* Effect.promise(() => blob.text())).toBe("memory attachment");
                expect(yield* other.bytes.read("file")).toBeUndefined();
                yield* first.destroy;
            }).pipe(Effect.provide(expoRuntime({ storage: "memory" })))
        )
    );
    expect(state.authenticate).toHaveBeenCalledOnce();
    expect(state.disconnect).toHaveBeenCalledTimes(2);
    expect(state.open).not.toHaveBeenCalled();
    expect(state.close).not.toHaveBeenCalled();
    expect(state.delete).not.toHaveBeenCalled();
    expect(state.directory).not.toHaveBeenCalled();
    expect(state.secrets).not.toHaveBeenCalled();
});
