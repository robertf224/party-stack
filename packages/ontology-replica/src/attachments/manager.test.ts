import { classifyBackendFailure } from "@party-stack/ontology-backend";
import { BackendError } from "@party-stack/ontology-backend";
import { makeBlobStorage, exclusiveOwnerLiveness } from "@party-stack/ontology-storage/blobs";
import { collectByteBlob } from "@party-stack/ontology-storage/blobs";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Runtime } from "@party-stack/runtime";
import { MemoryBlobBytesStore } from "@party-stack/runtime";
import { runtimeFixtureContext } from "@party-stack/runtime/testing";
import { closeRuntimeFixture } from "@party-stack/runtime/testing";
import { Context, Exit, Fiber, Scope } from "effect";
import { Deferred, Effect, Stream } from "effect";
import { expect, test, vi } from "vite-plus/test";
import {
    makeBlobManagerFromStorage,
    type BlobManagerService,
    type BlobManagerOptions as NativeBlobManagerOptions,
} from "./manager.js";
import type {
    PartialBlobMetadata,
    BlobReadOptions,
    BlobMetadataOptions,
} from "@party-stack/ontology-replica/attachments";
import type { BlobStorageService, ByteInput, ByteSource } from "@party-stack/ontology-storage/blobs";
import type { RuntimeService } from "@party-stack/runtime";
import type { RuntimeFixtureOptions } from "@party-stack/runtime/testing";

const makeBlobManager = Effect.fnUntraced(function* (options: NativeBlobManagerOptions) {
    const runtime = yield* Runtime;
    const storage = yield* makeBlobStorage({
        namespace: JSON.stringify([runtime.owner, runtime.namespace]),
        tables: runtime.tables,
        bytes: runtime.bytes,
        ...exclusiveOwnerLiveness(runtime.tables),
    }).pipe(Effect.mapError((cause) => classifyBackendFailure("attachment.storage", cause)));
    return yield* makeBlobManagerFromStorage({ ...options, storage });
});

export interface BlobRemoteSource {
    metadata?: (id: string, opts?: BlobMetadataOptions) => Promise<PartialBlobMetadata>;
    read: (id: string, opts?: BlobReadOptions) => Promise<ByteInput>;
}

export interface BlobManager {
    /** Native transactional storage for composition with a replica outbox. */
    readonly storage: Promise<BlobStorageService>;
    /** Resolves once blob metadata persistence has finished starting. */
    readonly ready: Promise<void>;
    stage: (id: string, blob: ByteInput) => Promise<void>;
    metadata: (id: string, opts?: BlobMetadataOptions) => Promise<PartialBlobMetadata & { id: string }>;
    source: (id: string, opts?: BlobReadOptions) => Promise<ByteSource>;
    read: (id: string, opts?: BlobReadOptions) => Promise<Blob>;
    bindRemoteId: (localId: string, remoteId: string) => Promise<void>;
    cleanup: () => Promise<void>;
}

export interface BlobManagerOptions {
    runtime: RuntimeService;
    scope: Scope.Scope;
    remote: BlobRemoteSource;
    gcTime?: number;
}

/** Test-only Promise runner over the native manager and its Scope. */
function blobManagerClient(
    service: BlobManagerService,
    run: <A>(effect: Effect.Effect<A, BackendError>, signal?: AbortSignal) => Promise<A>,
    cleanup: () => Promise<void> = () => Promise.resolve()
): BlobManager {
    return {
        storage: Promise.resolve(service.storage),
        ready: Promise.resolve(),
        stage: (id, input) => run(service.stage(id, input)),
        bindRemoteId: (id, remoteId) => run(service.bindRemoteId(id, remoteId)),
        source: (id, options) => run(service.source(id, options), options?.signal),
        read: (id, options) => run(service.read(id, options), options?.signal),
        metadata: (id, options) => run(service.metadata(id, options), options?.signal),
        cleanup,
    };
}

function createBlobManager(options: BlobManagerOptions): BlobManager {
    const runtime = options.runtime;
    const owner = Effect.runSync(Scope.fork(options.scope));
    const run = Effect.runPromiseWith(Context.make(Runtime, runtime));
    const initialized = run(
        Effect.flatMap(
            Effect.forkIn(
                Scope.provide(
                    makeBlobManager({
                        gcTime: options.gcTime,
                        remote: {
                            read: (id, settings) =>
                                Effect.tryPromise({
                                    try: (signal) =>
                                        options.remote.read(id, {
                                            ...settings,
                                            signal: settings?.signal
                                                ? AbortSignal.any([settings.signal, signal])
                                                : signal,
                                        }),
                                    catch: (cause) => classifyBackendFailure("attachment.read", cause),
                                }),
                            metadata: options.remote.metadata
                                ? (id, settings) =>
                                      Effect.tryPromise({
                                          try: (signal) =>
                                              options.remote.metadata!(id, {
                                                  ...settings,
                                                  signal: settings?.signal
                                                      ? AbortSignal.any([settings.signal, signal])
                                                      : signal,
                                              }),
                                          catch: (cause) =>
                                              classifyBackendFailure("attachment.metadata", cause),
                                      })
                                : undefined,
                        },
                    }),
                    owner
                ),
                owner
            ),
            Fiber.join
        )
    );
    let closing: Promise<void> | undefined;
    const cleanup = () => (closing ??= Effect.runPromise(Scope.close(owner, Exit.void)));
    const client = initialized.then((service) =>
        blobManagerClient(service, (effect, signal) => run(effect, { signal }), cleanup)
    );
    const storage = initialized.then((service) => service.storage);
    const ready = initialized.then(() => undefined);
    void client.catch(() => undefined);
    void storage.catch(() => undefined);
    void ready.catch(() => undefined);
    return {
        storage,
        ready,
        cleanup,
        stage: async (id, input) => (await client).stage(id, input),
        bindRemoteId: async (id, remoteId) => (await client).bindRemoteId(id, remoteId),
        source: async (id, settings) => (await client).source(id, settings),
        read: async (id, settings) => (await client).read(id, settings),
        metadata: async (id, settings) => (await client).metadata(id, settings),
    };
}

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
