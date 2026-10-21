import { CoordinationError, isCoordinationHost } from "@party-stack/runtime";
import { Runtime, runtimeEffects } from "@party-stack/runtime";
import { Clock, Effect, Exit, Fiber, Queue, Result, Scope } from "effect";
import { createStorageBlobManager } from "./createStorageBlobManager.js";
import { collectBlobGarbage } from "./gc/collectBlobGarbage.js";
import { measureBlobDimensions } from "./metadata/measureBlobDimensions.js";
import { BlobBytesUnavailableError, createBlobStore, type BlobStore } from "./store/createBlobStore.js";
import type {
    BlobManager,
    BlobManagerOptions,
    BlobMetadataField,
    BlobMetadataOptions,
    BlobMetadataRecord,
    PartialBlobMetadata,
} from "./types.js";

const DEFAULT_GC_TIME = 5 * 60 * 1_000;
const GC_WAKE_BATCH_TIME = 1;

function normalizeGCTime(value: number | undefined): number {
    const gcTime = value ?? DEFAULT_GC_TIME;
    if (Number.isNaN(gcTime) || gcTime < 0) {
        throw new RangeError("BlobManager gcTime must be a non-negative number.");
    }
    return gcTime;
}

const leaderWork = Effect.fn("Blobs.leader")(function* (
    store: BlobStore,
    wake: Queue.Queue<void>,
    gcTime: number
) {
    yield* Effect.tryPromise({ try: (signal) => store.recoverAsLeader(signal), catch: (cause) => cause });
    if (gcTime === Number.POSITIVE_INFINITY) return yield* Effect.never;
    for (;;) {
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.tryPromise({
            try: (signal) =>
                collectBlobGarbage(store, {
                    cutoff: gcTime === 0 ? Number.POSITIVE_INFINITY : now - gcTime,
                    now,
                    signal,
                }),
            catch: (cause) => cause,
        }).pipe(Effect.withSpan("Blobs.collectGarbage"));
        const changed = Queue.take(wake).pipe(Effect.andThen(Effect.sleep(GC_WAKE_BATCH_TIME)));
        yield* gcTime === 0 ? changed : Effect.raceFirst(changed, Effect.sleep(gcTime));
    }
});

const managerLifetime = Effect.fn("Blobs.lifetime")(function* (
    options: BlobManagerOptions,
    store: BlobStore,
    wake: Queue.Queue<void>,
    gcTime: number
) {
    const host = isCoordinationHost(options.runtime.coordination) ? options.runtime.coordination : undefined;
    if (!host) return yield* Effect.never;
    const context = yield* Effect.context<never>();
    for (;;) {
        const result = yield* Effect.result(
            Effect.tryPromise({
                try: (signal) =>
                    host.runAsLeader(
                        ({ signal }) =>
                            Effect.runPromiseWith(context)(
                                leaderWork(store, wake, gcTime).pipe(
                                    Effect.ensuring(Effect.sync(() => store.clearActiveOperations()))
                                ),
                                { signal }
                            ),
                        { signal }
                    ),
                catch: (cause) => cause,
            })
        );
        if (result._tag === "Success") return;
        if (!host.isLeader && !(result.failure instanceof CoordinationError)) {
            yield* Effect.yieldNow;
            continue;
        }
        return yield* Effect.fail(result.failure);
    }
});

function toPartialMetadata(ref: BlobMetadataRecord): PartialBlobMetadata {
    return {
        ...(ref.size !== undefined ? { size: ref.size } : {}),
        ...(ref.type !== undefined ? { type: ref.type } : {}),
        ...(ref.name !== undefined ? { name: ref.name } : {}),
        ...(ref.dimensions !== undefined ? { dimensions: ref.dimensions } : {}),
    };
}

export function createBlobManager(options: BlobManagerOptions): BlobManager {
    if (options.runtime.tables) return createStorageBlobManager(options);
    const gcTime = normalizeGCTime(options.gcTime);
    const owner = Effect.runSync(options.scope ? Scope.fork(options.scope) : Scope.make());
    const wake = Effect.runSync(Queue.sliding<void>(1));
    const lifetimeAbort = new AbortController();
    const managed = runtimeEffects(options.runtime).runtime;
    let closed = false;
    const store = createBlobStore({
        runtime: options.runtime,
        scope: owner,
        onCacheChanged: () => {
            Queue.offerUnsafe(wake, undefined);
        },
    });
    const initialized = managed
        .runPromise(
            Effect.gen(function* () {
                const runtime = yield* Runtime;
                if (!options.scope) yield* Scope.addFinalizer(runtime.scope, Scope.close(owner, Exit.void));
                yield* Scope.addFinalizer(
                    owner,
                    Effect.sync(() => {
                        Queue.shutdownUnsafe(wake);
                    })
                );
                yield* Effect.tryPromise({ try: () => store.ready, catch: (cause) => cause });
                // Register after metadata collection startup, so dependent store resources close first.
                yield* Scope.addFinalizer(
                    owner,
                    Effect.promise(() => store.cleanup())
                );
                yield* Scope.addFinalizer(
                    owner,
                    Effect.sync(() => {
                        closed = true;
                        lifetimeAbort.abort(new Error("Blob manager is closed."));
                    })
                );
                yield* Effect.forkIn(managerLifetime(options, store, wake, gcTime), owner, {
                    startImmediately: true,
                });
            })
        )
        .catch(async (cause: unknown) => {
            closed = true;
            lifetimeAbort.abort(cause);
            try {
                await store.cleanup();
            } finally {
                await Effect.runPromise(Scope.close(owner, Exit.void));
            }
            throw cause;
        });
    void initialized.catch(() => undefined);
    const runOperation = async <A>(run: (signal: AbortSignal) => Promise<A>): Promise<A> => {
        if (closed) throw new Error("Blob manager is closed.");
        await initialized;
        const result = await managed.runPromise(
            Effect.result(
                Effect.flatMap(
                    Effect.forkIn(
                        Effect.tryPromise({
                            try: (signal) => run(AbortSignal.any([signal, lifetimeAbort.signal])),
                            catch: (cause) => cause,
                        }),
                        owner
                    ),
                    Fiber.join
                )
            )
        );
        return Result.getOrThrow(result);
    };

    const isResolved = (record: BlobMetadataRecord | undefined, field: BlobMetadataField): boolean =>
        record !== undefined && record[field] !== undefined;

    const readLocalBlob = async (id: string): Promise<Blob | undefined> => {
        try {
            return await store.read(id);
        } catch (error) {
            if (error instanceof BlobBytesUnavailableError) return undefined;
            throw error;
        }
    };

    const mergeBlobMetadata = async (
        id: string,
        record: BlobMetadataRecord | undefined,
        blob: Blob,
        selection: readonly BlobMetadataField[],
        finalize: boolean,
        signal?: AbortSignal
    ): Promise<BlobMetadataRecord> => {
        const metadata: PartialBlobMetadata = {};
        if (!isResolved(record, "size")) metadata.size = blob.size;
        if (!isResolved(record, "type") && (blob.type || finalize)) {
            metadata.type = blob.type;
        }
        if (!isResolved(record, "name")) {
            if ("name" in blob && typeof blob.name === "string") {
                metadata.name = blob.name;
            } else if (finalize) {
                metadata.name = null;
            }
        }
        if (selection.includes("dimensions") && !isResolved(record, "dimensions")) {
            try {
                metadata.dimensions = await measureBlobDimensions(blob);
            } catch {
                if (finalize) metadata.dimensions = null;
            }
        }
        signal?.throwIfAborted();
        return store.upsertMetadata(id, metadata, false);
    };

    // Resolve selected fields in progressively more expensive steps:
    // persisted metadata -> available local bytes -> remote metadata for gaps
    // -> remote bytes as the final calculation fallback.
    const resolveMetadata = async (id: string, metadataOptions: BlobMetadataOptions = {}) => {
        metadataOptions.signal?.throwIfAborted();
        let record = await store.find(id);

        const selection = metadataOptions.select ?? ["size", "type", "name"];
        let localBlob = await readLocalBlob(id);
        if (localBlob) {
            record = await mergeBlobMetadata(id, record, localBlob, selection, false, metadataOptions.signal);
        }

        const missing = selection.filter((field) => !isResolved(record, field));
        const canLoadRemote = !record || record.state === "cached" || record.state === "persisted";
        let remoteMetadataError: unknown;
        if (missing.length > 0 && canLoadRemote && options.remote.metadata) {
            try {
                const remoteMetadata = await options.remote.metadata(record?.remoteId ?? id, {
                    meta: metadataOptions.meta,
                    select: missing,
                    signal: metadataOptions.signal,
                });
                metadataOptions.signal?.throwIfAborted();
                record = await store.upsertMetadata(id, remoteMetadata, true);
            } catch (error) {
                remoteMetadataError = error;
            }
        }

        const unresolved = selection.filter((field) => !isResolved(record, field));
        if (unresolved.length > 0) {
            try {
                localBlob ??= await readBytes(id, {
                    meta: metadataOptions.meta,
                    signal: metadataOptions.signal,
                });
                record = await mergeBlobMetadata(
                    id,
                    record,
                    localBlob,
                    unresolved,
                    true,
                    metadataOptions.signal
                );
            } catch (error) {
                if (remoteMetadataError !== undefined) {
                    throw new AggregateError(
                        [remoteMetadataError, error],
                        `Unable to resolve metadata for blob "${id}".`
                    );
                }
                throw error;
            }
        }

        const result: PartialBlobMetadata & { id: string } = {
            id,
            ...(record ? toPartialMetadata(record) : {}),
        };
        return result;
    };

    const fetchRemote = async (
        id: string,
        ref: BlobMetadataRecord | undefined,
        readOptions: Parameters<BlobManager["read"]>[1]
    ): Promise<Blob> => {
        const remoteId = ref?.remoteId ?? id;
        const blob = await options.remote.read(remoteId, readOptions);
        readOptions?.signal?.throwIfAborted();
        const name = typeof ref?.name === "string" ? ref.name : undefined;
        const cached = name
            ? new File([blob], name, {
                  type: ref?.type || blob.type,
              })
            : new Blob([blob], {
                  type: ref?.type || blob.type,
              });
        await store.cache(ref?.id ?? id, cached);
        return blob;
    };

    async function readBytes(id: string, readOptions?: Parameters<BlobManager["read"]>[1]): Promise<Blob> {
        readOptions?.signal?.throwIfAborted();
        const ref = await store.find(id);
        try {
            return await store.read(id);
        } catch (error) {
            if (!(error instanceof BlobBytesUnavailableError)) {
                throw error;
            }
            if (ref && ref.state !== "cached" && ref.state !== "persisted") {
                throw error;
            }
            return fetchRemote(id, ref, readOptions);
        }
    }

    let cleanupPromise: Promise<void> | undefined;
    return {
        collection: store.collection,
        ready: initialized,

        stage: (id, blob) =>
            runOperation(async () => {
                await store.stage(id, blob);
            }),

        metadata(id, metadataOptions) {
            return runOperation((signal) =>
                resolveMetadata(id, {
                    ...metadataOptions,
                    signal: metadataOptions?.signal
                        ? AbortSignal.any([signal, metadataOptions.signal])
                        : signal,
                })
            );
        },

        read: (id, readOptions) =>
            runOperation((signal) =>
                readBytes(id, {
                    ...readOptions,
                    signal: readOptions?.signal ? AbortSignal.any([signal, readOptions.signal]) : signal,
                })
            ),

        bindRemoteId: (localId, remoteId) =>
            runOperation(async () => {
                await store.bindRemoteId(localId, remoteId);
            }),

        cleanup() {
            cleanupPromise ??= (async () => {
                closed = true;
                lifetimeAbort.abort(new Error("Blob manager is closed."));
                await Promise.allSettled([initialized]);
                await Effect.runPromise(Scope.close(owner, Exit.void));
            })();
            return cleanupPromise;
        },
    };
}
