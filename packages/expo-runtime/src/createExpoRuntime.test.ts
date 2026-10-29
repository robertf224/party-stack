import { createHash } from "node:crypto";
import { Runtime } from "@party-stack/runtime";
import { RuntimePartition } from "@party-stack/runtime";
import { acquireRuntime } from "@party-stack/runtime/testing";
import { runtimeFixtureContext } from "@party-stack/runtime/testing";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { make, layer as platformLayer } from "./createExpoRuntime.js";
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
}));
vi.mock("expo-crypto", () => ({
    CryptoDigestAlgorithm: { SHA256: "SHA-256" },
    digestStringAsync: (_algorithm: string, value: string) =>
        Promise.resolve(createHash("sha256").update(value).digest("hex")),
}));
vi.mock("expo-sqlite", () => ({ openDatabaseAsync: state.open, deleteDatabaseAsync: state.delete }));
vi.mock("./ExpoNetworkConnectivity.js", () => ({
    ExpoNetworkConnectivity: { create: () => Promise.resolve({ close: state.disconnect }) },
}));
vi.mock("./ExpoFileSystemBlobBytesStore.js", () => ({
    ExpoFileSystemBlobBytesStore: class {
        constructor(options: unknown) {
            state.directory(options);
        }
        clear = () => Effect.sync(state.clear);
    },
}));
vi.mock("./ExpoKeyMaterialStore.js", () => ({ makeKeyMaterialStore: () => ({}) }));
vi.mock("./createExpoBrowserAuthentication.js", () => ({ createExpoBrowserAuthentication: () => ({}) }));

describe("createExpoRuntime", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        state.events = [];
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
