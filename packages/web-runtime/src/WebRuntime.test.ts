import { Table } from "@party-stack/ontology-storage/tables";
import { isCoordinationHost } from "@party-stack/runtime";
import { Runtime } from "@party-stack/runtime";
import { Deferred, Effect, Fiber } from "effect";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { layer } from "./WebRuntime.js";

afterEach(() => vi.unstubAllGlobals());
const platform = () => {
    const target = new EventTarget();
    const add = vi.fn(target.addEventListener.bind(target));
    const remove = vi.fn(target.removeEventListener.bind(target));
    vi.stubGlobal("addEventListener", add);
    vi.stubGlobal("removeEventListener", remove);
    vi.stubGlobal("navigator", { onLine: true });
    return { target, add, remove };
};

test("the platform runtime is acquired lazily and scope closure releases its resources", async () => {
    const p = platform();
    const runtimeLayer = layer({ owner: "test", namespace: "scoped", storage: "memory" });
    expect(p.add).not.toHaveBeenCalled();
    const runtime = await Effect.runPromise(
        Effect.gen(function* () {
            const runtime = yield* Runtime;
            expect(yield* runtime.online).toBe(true);
            yield* runtime.tables.put(Table.make<number>({ name: "rows" }), "one", 1);
            yield* runtime.bytes.write("bytes", new Blob(["data"]));
            const bytes = yield* runtime.bytes.read("bytes");
            expect(yield* Effect.promise(() => bytes!.text())).toBe("data");
            expect(p.add.mock.calls.map(([name]) => name)).toEqual(["online", "offline"]);
            return runtime;
        }).pipe(Effect.provide(runtimeLayer))
    );
    expect(p.remove.mock.calls.map(([name]) => name)).toEqual(["online", "offline"]);
    const coordination = runtime.adapter.coordination;
    if (!isCoordinationHost(coordination)) throw new Error("Expected a local host.");
    await expect(coordination.runAsLeader(() => undefined)).rejects.toThrow(/closed/i);
});

test("interrupting a program closes the whole runtime without an explicit cleanup call", async () => {
    const p = platform();
    await Effect.runPromise(
        Effect.gen(function* () {
            const ready = yield* Deferred.make<void>();
            const fiber = yield* Effect.forkChild(
                Effect.gen(function* () {
                    yield* Runtime;
                    yield* Deferred.succeed(ready, undefined);
                    yield* Effect.never;
                }).pipe(Effect.provide(layer({ owner: "test", namespace: "interrupted", storage: "memory" })))
            );
            yield* Deferred.await(ready);
            yield* Fiber.interrupt(fiber);
        })
    );
    expect(p.remove).toHaveBeenCalledTimes(2);
});

test("failed storage acquisition releases earlier platform resources", async () => {
    const p = platform();
    const close = vi.fn();
    vi.stubGlobal(
        "BroadcastChannel",
        class extends EventTarget {
            close = close;
        }
    );
    vi.stubGlobal("navigator", { onLine: true, storage: { getDirectory: vi.fn() } });
    vi.stubGlobal("indexedDB", {
        open: () => {
            throw new Error("Storage denied");
        },
    });
    vi.stubGlobal("IDBKeyRange", {});
    const result = await Effect.runPromise(
        Effect.result(
            Runtime.pipe(
                Effect.provide(layer({ owner: "test", namespace: "denied", coordination: "single-process" }))
            )
        )
    );
    expect(result._tag).toBe("Failure");
    expect(close).toHaveBeenCalledOnce();
    expect(p.remove).toHaveBeenCalledTimes(2);
});

test("unavailable shared APIs require an explicit isolated-memory choice", async () => {
    const p = platform();
    vi.stubGlobal("BroadcastChannel", undefined);
    vi.stubGlobal("indexedDB", undefined);
    const result = await Effect.runPromise(
        Effect.result(Runtime.pipe(Effect.provide(layer({ owner: "test", namespace: "unsupported" }))))
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: { operation: "webRuntime.coordination" } });
    expect(p.add).not.toHaveBeenCalled();
    await Effect.runPromise(
        Runtime.pipe(Effect.provide(layer({ owner: "test", namespace: "isolated", storage: "memory" })))
    );
    expect(p.remove).toHaveBeenCalledTimes(2);
});

test("the installation factory shares one acquired Layer and disposes it exactly once", async () => {
    const p = platform();
    const { createWebRuntime } = await import("./createWebRuntime.js");
    const { runtimeEffects } = await import("@party-stack/runtime");
    const adapter = await createWebRuntime("test", "factory", { storage: "memory" });
    const managed = runtimeEffects(adapter).runtime;
    const service = await managed.runPromise(Runtime);
    expect(runtimeEffects(service.adapter).runtime).toBe(managed);
    expect(p.add).toHaveBeenCalledTimes(2);
    await Promise.all([adapter.cleanup?.(), adapter.cleanup?.()]);
    expect(p.remove).toHaveBeenCalledTimes(2);
    expect(() => runtimeEffects(service.adapter)).toThrow("Runtime is closed");
});
