import { BackendError } from "@party-stack/ontology-backend";
import { collectByteBlob } from "@party-stack/ontology-storage/blobs";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { MemoryBlobBytesStore } from "@party-stack/runtime";
import { runtimeFixtureContext } from "@party-stack/runtime/testing";
import { closeRuntimeFixture } from "@party-stack/runtime/testing";
import { Deferred, Effect, Stream } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { createBlobManager } from "./createBlobManager.js";
import type { RuntimeFixtureOptions } from "@party-stack/runtime/testing";

test("native blob facade loads metadata on demand and preserves remote aliases after eviction", async () => {
    const tables = await Effect.runPromise(Memory.make());
    const bytes = new MemoryBlobBytesStore();
    const runtime: RuntimeFixtureOptions = {
        owner: "user",
        namespace: "native",
        tables: Effect.succeed(tables),

        blobBytes: bytes,
    };
    runtimeFixtureContext(runtime);
    const read = vi.fn(() => Promise.resolve(new Blob(["refetched"], { type: "text/plain" })));
    const manager = createBlobManager({
        runtime: runtimeFixtureContext(runtime).service,
        scope: runtimeFixtureContext(runtime).scope,
        remote: { read },
        gcTime: Infinity,
    });
    try {
        await manager.ready;
        await manager.stage("local", new File(["staged"], "file.txt", { type: "text/plain" }));
        expect(await manager.metadata("local")).toMatchObject({ id: "local", size: 6, name: "file.txt" });
        expect(read).not.toHaveBeenCalled();
        await manager.bindRemoteId("local", "remote");
        expect(await (await manager.read("remote")).text()).toBe("staged");
        const storage = await manager.storage!;
        await Effect.runPromise(storage.collectGarbage({ olderThanMs: 0 }));
        expect(bytes.blobs.size).toBe(0);
        expect(await (await manager.read("local")).text()).toBe("refetched");
        expect(read).toHaveBeenCalledWith("remote", expect.anything());
        const records = (await Effect.runPromise(storage.records())).map((row) => row.value);
        expect(records).toMatchObject([{ id: "local", remoteId: "remote" }]);
        await Effect.runPromise(tables.transaction((tx) => storage.in(tx).retain("pending", ["local"])));
        bytes.blobs.clear();
        expect(await (await manager.read("local")).text()).toBe("refetched");
        expect(await manager.metadata("local")).toMatchObject({ name: "file.txt" });
        await Effect.runPromise(tables.transaction((tx) => storage.in(tx).release("pending")));
    } finally {
        await manager.cleanup();
        await closeRuntimeFixture(runtime);
    }
});

test("native blob cleanup aborts remote work and fences a late non-cancelable response", async () => {
    const tables = await Effect.runPromise(Memory.make());
    const bytes = new MemoryBlobBytesStore();
    const runtime: RuntimeFixtureOptions = {
        owner: "user",
        namespace: "cancel",
        tables: Effect.succeed(tables),

        blobBytes: bytes,
    };
    runtimeFixtureContext(runtime);
    let signal: AbortSignal | undefined;
    let finish!: (value: Blob) => void;
    const response = new Promise<Blob>((resolve) => {
        finish = resolve;
    });
    const manager = createBlobManager({
        runtime: runtimeFixtureContext(runtime).service,
        scope: runtimeFixtureContext(runtime).scope,
        gcTime: Infinity,
        remote: {
            read: (_id, options) => {
                signal = options?.signal;
                return response;
            },
        },
    });
    const pending = manager.read("remote").catch((error: unknown) => error);
    try {
        await vi.waitFor(() => expect(signal).toBeDefined());
        await manager.cleanup();
        expect(signal?.aborted).toBe(true);
        finish(new Blob(["late"]));
        await pending;
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        expect(bytes.blobs.size).toBe(0);
    } finally {
        finish(new Blob());
        await manager.cleanup();
        await closeRuntimeFixture(runtime);
    }
});

test("a cold read delivers its first bytes before EOF and commits the cache before completion", async () => {
    const runtime: RuntimeFixtureOptions = {
        owner: "user",
        namespace: "progressive",
        tables: Memory.make(),
        blobBytes: new MemoryBlobBytesStore(),
    };
    runtimeFixtureContext(runtime);
    const release = Effect.runSync(Deferred.make<void>());
    const received = Effect.runSync(Deferred.make<void>());
    let finished = false;
    const read = vi.fn(async () => ({
        type: "text/plain",
        stream: Stream.concat(
            Stream.make(new TextEncoder().encode("first")),
            Stream.fromEffect(
                Deferred.await(release).pipe(
                    Effect.map(() => {
                        finished = true;
                        return new TextEncoder().encode("last");
                    })
                )
            )
        ),
    }));
    const manager = createBlobManager({
        runtime: runtimeFixtureContext(runtime).service,
        scope: runtimeFixtureContext(runtime).scope,
        remote: { read },
        gcTime: Infinity,
    });
    try {
        const source = await manager.source("remote");
        expect(finished).toBe(false);
        const consuming = Effect.runPromise(
            collectByteBlob({
                ...source,
                stream: source.stream.pipe(Stream.tap(() => Deferred.succeed(received, undefined))),
            })
        );
        await Effect.runPromise(Deferred.await(received).pipe(Effect.timeout("2 seconds")));
        expect(finished).toBe(false);
        expect(
            (await Effect.runPromise((await manager.storage).metadata("remote")))?.byteKey
        ).toBeUndefined();
        await Effect.runPromise(Deferred.succeed(release, undefined));
        expect(await (await consuming).text()).toBe("firstlast");
        expect((await Effect.runPromise((await manager.storage).metadata("remote")))?.byteKey).toBeDefined();
        expect(await (await manager.read("remote")).text()).toBe("firstlast");
        expect(await (await Effect.runPromise(collectByteBlob(source))).text()).toBe("firstlast");
        expect(read).toHaveBeenCalledOnce();
    } finally {
        await Effect.runPromise(Deferred.succeed(release, undefined));
        await manager.cleanup();
        await closeRuntimeFixture(runtime);
    }
});

test("canceling a progressive reader settles its partial write before another reader retries", async () => {
    const bytes = new MemoryBlobBytesStore();
    const runtime: RuntimeFixtureOptions = {
        owner: "user",
        namespace: "progressive-cancel",
        tables: Memory.make(),
        blobBytes: bytes,
    };
    runtimeFixtureContext(runtime);
    const release = Effect.runSync(Deferred.make<void>());
    const read = vi.fn(async () => ({
        type: "text/plain",
        stream: Stream.concat(
            Stream.make(new Uint8Array([1])),
            Stream.fromEffect(Deferred.await(release).pipe(Effect.as(new Uint8Array([2]))))
        ),
    }));
    const manager = createBlobManager({
        runtime: runtimeFixtureContext(runtime).service,
        scope: runtimeFixtureContext(runtime).scope,
        remote: { read },
        gcTime: Infinity,
    });
    try {
        const source = await manager.source("remote");
        expect(await Effect.runPromise(Stream.runCollect(Stream.take(source.stream, 1)))).toEqual([
            new Uint8Array([1]),
        ]);
        expect(
            (await Effect.runPromise((await manager.storage).metadata("remote")))?.writing
        ).toBeUndefined();
        expect(bytes.blobs.size).toBe(0);
        await Effect.runPromise(Deferred.succeed(release, undefined));
        expect(new Uint8Array(await (await manager.read("remote")).arrayBuffer())).toEqual(
            new Uint8Array([1, 2])
        );
        expect(read).toHaveBeenCalledTimes(2);
    } finally {
        await Effect.runPromise(Deferred.succeed(release, undefined));
        await manager.cleanup();
        await closeRuntimeFixture(runtime);
    }
});

test.each(["Forbidden", "Unauthenticated", "Unavailable", "InvalidResponse"] as const)(
    "metadata propagates %s without downloading attachment bytes",
    async (kind) => {
        const runtime: RuntimeFixtureOptions = {
            owner: "user",
            namespace: `metadata-${kind}`,
            tables: Memory.make(),
            blobBytes: new MemoryBlobBytesStore(),
        };
        runtimeFixtureContext(runtime);
        const error = new BackendError({ operation: "metadata", kind, message: "Failed", retryable: false });
        const read = vi.fn(async () => new Blob(["private"]));
        const manager = createBlobManager({
            runtime: runtimeFixtureContext(runtime).service,
            scope: runtimeFixtureContext(runtime).scope,
            remote: {
                read,
                metadata: async () => {
                    throw error;
                },
            },
        });
        try {
            await expect(manager.metadata("remote")).rejects.toBe(error);
            expect(read).not.toHaveBeenCalled();
        } finally {
            await manager.cleanup();
            await closeRuntimeFixture(runtime);
        }
    }
);

test.each(["unconsumed", "consuming"])(
    "aborting a %s source after headers releases its partial cache write",
    async (mode) => {
        const bytes = new MemoryBlobBytesStore();
        const runtime: RuntimeFixtureOptions = {
            owner: "user",
            namespace: "abort-source",
            tables: Memory.make(),
            blobBytes: bytes,
        };
        runtimeFixtureContext(runtime);
        const started = Effect.runSync(Deferred.make<void>());
        const stopped = Effect.runSync(Deferred.make<void>());
        let attempts = 0;
        const manager = createBlobManager({
            runtime: runtimeFixtureContext(runtime).service,
            scope: runtimeFixtureContext(runtime).scope,
            remote: {
                read: async () => ({
                    type: "text/plain",
                    stream:
                        ++attempts === 1
                            ? Stream.concat(Stream.make(new Uint8Array([1])), Stream.never).pipe(
                                  Stream.tap(() => Deferred.succeed(started, undefined)),
                                  Stream.ensuring(Deferred.succeed(stopped, undefined))
                              )
                            : Stream.make(new Uint8Array([2])),
                }),
            },
        });
        try {
            const abort = new AbortController();
            const source = await manager.source("remote", { signal: abort.signal });
            if (mode === "unconsumed") {
                // Exercise cancellation of an acquired producer, rather than one
                // aborted before its stream/finalizer ever starts.
                await Effect.runPromise(Deferred.await(started).pipe(Effect.timeout("2 seconds")));
                abort.abort();
            }
            const content =
                mode === "consuming"
                    ? {
                          ...source,
                          stream: source.stream.pipe(Stream.tap(() => Effect.sync(() => abort.abort()))),
                      }
                    : source;
            await expect(Effect.runPromise(collectByteBlob(content))).rejects.toBeDefined();
            await Effect.runPromise(Deferred.await(stopped).pipe(Effect.timeout("2 seconds")));
            const retried = await manager.read("remote");
            expect(new Uint8Array(await retried.arrayBuffer())).toEqual(new Uint8Array([2]));
            expect(attempts).toBe(2);
        } finally {
            await manager.cleanup();
            await closeRuntimeFixture(runtime);
        }
    }
);
