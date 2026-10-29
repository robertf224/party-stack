import { Table } from "@party-stack/ontology-storage/tables";
import { collectByteBlob } from "@party-stack/runtime";
import { Runtime, RuntimePartition } from "@party-stack/runtime";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { layer as platformLayer } from "./WebRuntime.js";
const layer = ({
    owner,
    namespace,
    ...options
}: {
    owner: string;
    namespace: string;
    storage?: "indexeddb" | "memory";
}) => platformLayer(options).pipe(Layer.provide(Layer.succeed(RuntimePartition)({ owner, namespace })));

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
    await Effect.runPromise(
        Effect.gen(function* () {
            const runtime = yield* Runtime;
            expect(yield* runtime.online).toBe(true);
            yield* runtime.tables.put(Table.make<number>({ name: "rows" }), "one", 1);
            yield* runtime.bytes.write("bytes", new Blob(["data"]));
            const bytes = yield* runtime.bytes.read("bytes");
            const blob = yield* collectByteBlob(bytes!);
            expect(yield* Effect.promise(() => blob.text())).toBe("data");
            expect(p.add.mock.calls.map(([name]) => name)).toEqual(["online", "offline"]);
            return runtime;
        }).pipe(Effect.provide(runtimeLayer))
    );
    expect(p.remove.mock.calls.map(([name]) => name)).toEqual(["online", "offline"]);
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
    vi.stubGlobal("navigator", { onLine: true, storage: { getDirectory: vi.fn() } });
    vi.stubGlobal("indexedDB", {
        open: () => {
            throw new Error("Storage denied");
        },
    });
    vi.stubGlobal("IDBKeyRange", {});
    const result = await Effect.runPromise(
        Effect.result(Runtime.pipe(Effect.provide(layer({ owner: "test", namespace: "denied" }))))
    );
    expect(result._tag).toBe("Failure");
    expect(p.remove).toHaveBeenCalledTimes(2);
});

test("unavailable persistent storage requires an explicit isolated-memory choice", async () => {
    const p = platform();
    vi.stubGlobal("indexedDB", undefined);
    const result = await Effect.runPromise(
        Effect.result(Runtime.pipe(Effect.provide(layer({ owner: "test", namespace: "unsupported" }))))
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: { operation: "webRuntime.storage" } });
    expect(p.add).not.toHaveBeenCalled();
    await Effect.runPromise(
        Runtime.pipe(Effect.provide(layer({ owner: "test", namespace: "isolated", storage: "memory" })))
    );
    expect(p.remove).toHaveBeenCalledTimes(2);
});
