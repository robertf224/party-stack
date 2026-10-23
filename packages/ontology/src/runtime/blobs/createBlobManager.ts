import {
    BlobStorageError,
    makeBlobStorage,
    type BlobStorageService,
    type BlobRecord,
} from "@party-stack/ontology-storage/blobs";
import { Runtime, getRuntime } from "@party-stack/runtime";
import { Effect, Exit, Fiber, Scope, Stream } from "effect";
import { measureBlobDimensions } from "./measureBlobDimensions.js";
import type { BlobManager, BlobManagerOptions, BlobMetadataOptions, PartialBlobMetadata } from "./types.js";

/** Application Promise facade over the storage-owned Effect service. */
export function createBlobManager(options: BlobManagerOptions): BlobManager {
    // Hosts enable cache collection after wiring transactional outbox retention.
    const gcTime = options.gcTime ?? Infinity;
    if (Number.isNaN(gcTime) || gcTime < 0)
        throw new RangeError("BlobManager gcTime must be a non-negative number.");
    const runtimeService = getRuntime(options.runtime);
    const managed = { runPromise: Effect.runPromiseWith(runtimeService.context) };
    const owner = Effect.runSync(Scope.fork(runtimeService.scope));
    if (options.scope) Effect.runSync(Scope.addFinalizer(options.scope, Scope.close(owner, Exit.void)));
    let closed = false;
    const namespace = JSON.stringify([options.runtime.owner, options.runtime.namespace]);
    const initialized = managed.runPromise(
        Effect.gen(function* () {
            const runtime = yield* Runtime;
            return yield* Scope.provide(
                Effect.gen(function* () {
                    const storage = yield* makeBlobStorage({
                        namespace,
                        tables: runtime.tables,
                        bytes: runtime.bytes,
                        registerOwner: options.runtime.actorLiveness
                            ? (id) =>
                                  options.runtime.actorLiveness!.acquire(id).pipe(
                                      Effect.mapError(
                                          (cause) =>
                                              new BlobStorageError({
                                                  kind: "Bytes",
                                                  message: "Blob owner registration failed.",
                                                  cause,
                                              })
                                      )
                                  )
                            : undefined,
                        isOwnerAlive: options.runtime.actorLiveness
                            ? (id) =>
                                  options.runtime.actorLiveness!.isAlive(id).pipe(
                                      Effect.mapError(
                                          (cause) =>
                                              new BlobStorageError({
                                                  kind: "Bytes",
                                                  message: "Blob owner lookup failed.",
                                                  cause,
                                              })
                                      )
                                  )
                            : undefined,
                    });
                    yield* Effect.addFinalizer(() =>
                        Effect.sync(() => {
                            closed = true;
                        })
                    );
                    const collect = Effect.gen(function* () {
                        if (gcTime !== Infinity) yield* storage.collectGarbage({ olderThanMs: gcTime });
                    }).pipe(
                        Effect.catch((error) =>
                            Effect.logWarning("Blob cache maintenance failed.", error._tag)
                        )
                    );
                    const maintenance = Effect.gen(function* () {
                        yield* storage.recover.pipe(
                            Effect.catch((error) => Effect.logWarning("Blob recovery failed.", error._tag))
                        );
                        yield* collect;
                        if (gcTime === Infinity) return yield* Effect.never;
                        yield* Effect.forkScoped(Stream.runForEach(runtime.changes, () => collect));
                        for (;;) {
                            yield* Effect.sleep(Math.max(10, gcTime));
                            yield* storage.recover.pipe(
                                Effect.catch((error) =>
                                    Effect.logWarning("Blob recovery failed.", error._tag)
                                )
                            );
                            yield* collect;
                        }
                    });
                    yield* Effect.forkIn(maintenance, owner);
                    return { storage, notify: runtime.notify };
                }),
                owner
            );
        })
    );
    void initialized.catch(() => undefined);
    const run = async <A>(
        work: (storage: BlobStorageService) => Effect.Effect<A, unknown>,
        signal?: AbortSignal
    ) => {
        if (closed) throw new Error("Blob manager is closed.");
        const { storage } = await initialized;
        if (closed) throw new Error("Blob manager is closed.");
        return managed.runPromise(
            Effect.acquireUseRelease(Effect.forkIn(work(storage), owner), Fiber.join, Fiber.interrupt),
            {
                signal,
            }
        );
    };
    const notify = () => initialized.then(({ notify }) => managed.runPromise(notify));
    const reads = new Map<string, Promise<Blob>>();
    const read = async (id: string, readOptions: Parameters<BlobManager["read"]>[1]): Promise<Blob> => {
        const local = await run((storage) => storage.read(id), readOptions?.signal);
        if (local) return local;
        const record = await run((storage) => storage.metadata(id), readOptions?.signal);
        if (record?.state === "staged") throw new Error("Staged blob bytes are unavailable locally.");
        // Keep cancellation isolated per caller; shared remote reads would let one
        // observer cancel another observer's independently owned demand.
        const fetch = async () => {
            const blob = await run(
                () =>
                    Effect.tryPromise({
                        try: (signal) =>
                            options.remote.read(record?.remoteId ?? id, {
                                ...readOptions,
                                signal: readOptions?.signal
                                    ? AbortSignal.any([readOptions.signal, signal])
                                    : signal,
                            }),
                        catch: (cause) => cause,
                    }),
                readOptions?.signal
            );
            await run((storage) => storage.cache(record?.id ?? id, blob), readOptions?.signal);
            await notify();
            return blob;
        };
        if (readOptions?.signal) return fetch();
        let pending = reads.get(id);
        if (!pending) {
            pending = fetch().finally(() => {
                reads.delete(id);
            });
            reads.set(id, pending);
        }
        return pending;
    };
    const metadata = async (id: string, settings: BlobMetadataOptions = {}) => {
        const select = settings.select ?? ["size", "type", "name"];
        let record = await run((storage) => storage.metadata(id), settings.signal);
        let missing = select.filter((field) => record?.[field] === undefined);
        if (missing.length && record?.state !== "staged" && options.remote.metadata) {
            try {
                const remote = await run(
                    () =>
                        Effect.tryPromise({
                            try: (signal) =>
                                options.remote.metadata!(record?.remoteId ?? id, {
                                    ...settings,
                                    select: missing,
                                    signal: settings.signal
                                        ? AbortSignal.any([settings.signal, signal])
                                        : signal,
                                }),
                            catch: (cause) => cause,
                        }),
                    settings.signal
                );
                record = await run((storage) => storage.updateMetadata(id, remote), settings.signal);
            } catch (cause) {
                if (settings.signal?.aborted) throw cause;
                // Bytes can supply metadata when a provider has no usable metadata endpoint.
            }
        }
        missing = select.filter((field) => record?.[field] === undefined);
        if (missing.length) {
            const blob = await read(id, settings);
            const patch: PartialBlobMetadata = {
                size: blob.size,
                type: blob.type,
                name: "name" in blob && typeof blob.name === "string" ? blob.name : null,
            };
            if (missing.includes("dimensions"))
                patch.dimensions = await measureBlobDimensions(blob).catch(() => null);
            record = await run((storage) => storage.updateMetadata(id, patch), settings.signal);
        }
        return { id, ...pickMetadata(record) };
    };
    const ready = initialized.then(() => undefined);
    const storage = initialized.then(({ storage }) => storage);
    void ready.catch(() => undefined);
    void storage.catch(() => undefined);
    let cleanupPromise: Promise<void> | undefined;
    return {
        ready,
        storage,
        stage: async (id, blob) => {
            await run((storage) => storage.stage(id, blob));
            await notify();
        },
        bindRemoteId: async (id, remoteId) => {
            await run((storage) => storage.bindRemoteId(id, remoteId));
            await notify();
        },
        read,
        metadata,
        cleanup: () =>
            (cleanupPromise ??= (async () => {
                closed = true;
                await Promise.allSettled([initialized]);
                await Effect.runPromise(Scope.close(owner, Exit.void));
            })()),
    };
}

function pickMetadata(record: BlobRecord | undefined): PartialBlobMetadata {
    return record
        ? { size: record.size, type: record.type, name: record.name, dimensions: record.dimensions }
        : {};
}
