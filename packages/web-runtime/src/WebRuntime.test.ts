import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { collectByteBlob } from "@party-stack/runtime";
import { Runtime, RuntimeError, RuntimePartition } from "@party-stack/runtime";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { layer as platformLayer, type WebRuntimeOptions } from "./WebRuntime.js";
const layer = ({
    owner,
    namespace,
    ...options
}: WebRuntimeOptions & {
    owner: string;
    namespace: string;
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
            expect(yield* runtime.connectivity.online).toBe(true);
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

test("memory runtimes do not report browser disk quota as cache capacity", async () => {
    platform();
    const estimate = vi.fn(async () => ({ usage: 12, quota: 100 }));
    vi.stubGlobal("navigator", { onLine: true, storage: { estimate } });
    await Effect.runPromise(
        Effect.gen(function* () {
            const runtime = yield* Runtime;
            expect(yield* runtime.capacity!.memory).toBeUndefined();
            expect(yield* runtime.capacity!.storage).toBeUndefined();
        }).pipe(Effect.provide(layer({ owner: "test", namespace: "capacity", storage: "memory" })))
    );
    expect(estimate).not.toHaveBeenCalled();
});

test("forget waits for IndexedDB deletion to finish after a blocked notification", async () => {
    platform();
    type Request = { result?: unknown; onsuccess?: () => void; onblocked?: () => void };
    const deletes: Request[] = [];
    vi.stubGlobal("indexedDB", {
        open: () => {
            const request: Request = { result: { close: vi.fn() } };
            queueMicrotask(() => request.onsuccess?.());
            return request;
        },
        deleteDatabase: () => {
            const request: Request = {};
            deletes.push(request);
            queueMicrotask(() => {
                request.onblocked?.();
                request.onsuccess?.();
            });
            return request;
        },
    });
    vi.stubGlobal("IDBKeyRange", {});
    vi.stubGlobal("navigator", {
        onLine: true,
        storage: { getDirectory: async () => ({ removeEntry: async () => {} }) },
    });
    const runtime = await Effect.runPromise(
        Runtime.pipe(Effect.provide(layer({ owner: "test", namespace: "forget" })))
    );
    await Effect.runPromise(runtime.destroy);
    expect(deletes).toHaveLength(3);
});

test("custom table acquisition is lazy, partition-scoped, and remains destroyable after release", async () => {
    platform();
    let opened = 0;
    let closed = 0;
    let destroyed = 0;
    const custom = Effect.gen(function* () {
        const partition = yield* RuntimePartition;
        expect(partition).toEqual({ owner: "device", namespace: "custom" });
        const tables = yield* Effect.acquireRelease(
            Memory.make().pipe(
                Effect.tap(() =>
                    Effect.sync(() => {
                        opened++;
                    })
                )
            ),
            () =>
                Effect.sync(() => {
                    closed++;
                })
        );
        return {
            tables,
            destroy: Effect.sync(() => {
                destroyed++;
            }),
        };
    });
    const runtimeLayer = layer({ owner: "device", namespace: "custom", storage: "memory", tables: custom });
    expect(opened).toBe(0);
    const runtime = await Effect.runPromise(Runtime.pipe(Effect.provide(runtimeLayer)));
    expect(opened).toBe(1);
    expect(closed).toBe(1);
    expect(destroyed).toBe(0);
    await Effect.runPromise(runtime.destroy);
    expect(destroyed).toBe(1);
});

test("persistent custom tables retain browser capabilities without opening or deleting built-in table databases", async () => {
    platform();
    const open = vi.fn(() => {
        throw new Error("Built-in table database must not open");
    });
    const deleted: string[] = [];
    let destroyed = 0;
    vi.stubGlobal("indexedDB", {
        open,
        deleteDatabase: (name: string) => {
            deleted.push(name);
            const request: { onsuccess?: () => void } = {};
            queueMicrotask(() => request.onsuccess?.());
            return request;
        },
    });
    vi.stubGlobal("IDBKeyRange", {});
    vi.stubGlobal("navigator", {
        onLine: true,
        storage: { getDirectory: async () => ({ removeEntry: async () => {} }) },
    });
    const runtime = await Effect.runPromise(
        Runtime.pipe(
            Effect.provide(
                layer({
                    owner: "device",
                    namespace: "sql",
                    tables: Effect.map(Memory.make(), (tables) => ({
                        tables,
                        destroy: Effect.sync(() => {
                            destroyed++;
                        }),
                    })),
                })
            )
        )
    );
    expect(open).not.toHaveBeenCalled();
    await Effect.runPromise(runtime.destroy);
    expect(destroyed).toBe(1);
    expect(deleted).toEqual(['party-stack:["device","sql"]:keys']);
});

test("failed custom table acquisition releases the platform scope and preserves the typed error", async () => {
    const p = platform();
    const failure = new RuntimeError({ operation: "custom.tables", cause: new Error("Denied") });
    const result = await Effect.runPromise(
        Effect.result(
            Runtime.pipe(
                Effect.provide(
                    layer({
                        owner: "device",
                        namespace: "failed",
                        storage: "memory",
                        tables: Effect.fail(failure),
                    })
                )
            )
        )
    );
    expect(result).toMatchObject({ _tag: "Failure", failure });
    expect(p.remove).toHaveBeenCalledTimes(2);
});
