import { batch } from "@effectionx/stream-helpers";
import { CoordinationError, isCoordinationHost } from "@party-stack/runtime";
import {
    action,
    createSignal,
    race,
    run,
    sleep,
    suspend,
    until,
    useAbortSignal,
    useScope,
    type Operation,
    type Scope,
    type Signal,
    type Task,
} from "effection";
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

function waitForAbort(signal: AbortSignal): Operation<void> {
    return action<void>((resolve) => {
        const abort = () => resolve();
        if (signal.aborted) {
            abort();
            return () => undefined;
        }
        signal.addEventListener("abort", abort, {
            once: true,
        });
        return () => signal.removeEventListener("abort", abort);
    });
}

function normalizeGCTime(value: number | undefined): number {
    const gcTime = value ?? DEFAULT_GC_TIME;
    if (Number.isNaN(gcTime) || gcTime < 0) {
        throw new RangeError("BlobManager gcTime must be a non-negative number.");
    }
    return gcTime;
}

function ignoreEffectionHalt(error: unknown): void {
    if (error instanceof Error && error.message === "halted") {
        return;
    }
    throw error;
}

function* useBlobLeader(store: BlobStore, wake: Signal<void, never>, gcTime: number): Operation<void> {
    const signal = yield* useAbortSignal();
    yield* until(store.recoverAsLeader(signal));
    try {
        if (gcTime === Number.POSITIVE_INFINITY) {
            yield* suspend();
            return;
        }

        const wakes = yield* batch({
            maxTime: GC_WAKE_BATCH_TIME,
        })(wake);
        while (true) {
            const now = Date.now();
            yield* until(
                collectBlobGarbage(store, {
                    cutoff: gcTime === 0 ? Number.POSITIVE_INFINITY : now - gcTime,
                    now,
                    signal,
                })
            );
            if (gcTime === 0) {
                yield* wakes.next();
            } else {
                yield* race([wakes.next(), sleep(gcTime)]);
            }
        }
    } finally {
        store.clearActiveOperations();
    }
}

function startLeaderTerm(
    scope: Scope,
    signal: AbortSignal,
    store: BlobStore,
    wake: Signal<void, never>,
    gcTime: number
): Task<void> {
    return scope.run(() => race([useBlobLeader(store, wake, gcTime), waitForAbort(signal)]));
}

function* useManagerLifetime(
    options: BlobManagerOptions,
    store: BlobStore,
    wake: Signal<void, never>,
    gcTime: number
): Operation<void> {
    let leaderTask: Task<void> | undefined;
    const host = isCoordinationHost(options.runtime.coordination) ? options.runtime.coordination : undefined;
    try {
        if (!host) {
            yield* suspend();
            return;
        }

        const scope = yield* useScope();
        const lifetimeSignal = yield* useAbortSignal();
        while (!lifetimeSignal.aborted) {
            try {
                yield* until(
                    host.runAsLeader(
                        ({ signal }) => {
                            const task = startLeaderTerm(scope, signal, store, wake, gcTime);
                            leaderTask = task;
                            return Promise.resolve(task).finally(() => {
                                if (leaderTask === task) {
                                    leaderTask = undefined;
                                }
                            });
                        },
                        { signal: lifetimeSignal }
                    )
                );
                return;
            } catch (error) {
                if (lifetimeSignal.aborted) return;
                if (!host.isLeader && !(error instanceof CoordinationError)) {
                    continue;
                }
                throw error;
            }
        }
    } finally {
        try {
            if (leaderTask) {
                yield* until(Promise.resolve(leaderTask.halt()).catch(() => undefined));
            }
        } finally {
            store.clearActiveOperations();
            yield* until(store.cleanup());
        }
    }
}

function toPartialMetadata(ref: BlobMetadataRecord): PartialBlobMetadata {
    return {
        ...(ref.size !== undefined ? { size: ref.size } : {}),
        ...(ref.type !== undefined ? { type: ref.type } : {}),
        ...(ref.name !== undefined ? { name: ref.name } : {}),
        ...(ref.dimensions !== undefined ? { dimensions: ref.dimensions } : {}),
    };
}

export function createBlobManager(options: BlobManagerOptions): BlobManager {
    const gcTime = normalizeGCTime(options.gcTime);
    const wake = createSignal<void>();
    const store = createBlobStore({
        runtime: options.runtime,
        onCacheChanged: () => wake.send(),
    });

    const lifetime = run(() => useManagerLifetime(options, store, wake, gcTime));
    void lifetime.catch(() => undefined);

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
        finalize: boolean
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
        return store.upsertMetadata(id, metadata, false);
    };

    // Resolve selected fields in progressively more expensive steps:
    // persisted metadata -> available local bytes -> remote metadata for gaps
    // -> remote bytes as the final calculation fallback.
    const resolveMetadata = async (id: string, metadataOptions: BlobMetadataOptions = {}) => {
        let record = await store.find(id);

        const selection = metadataOptions.select ?? ["size", "type", "name"];
        let localBlob = await readLocalBlob(id);
        if (localBlob) {
            record = await mergeBlobMetadata(id, record, localBlob, selection, false);
        }

        const missing = selection.filter((field) => !isResolved(record, field));
        const canLoadRemote = !record || record.state === "cached" || record.state === "persisted";
        let remoteMetadataError: unknown;
        if (missing.length > 0 && canLoadRemote && options.remote.metadata) {
            try {
                const remoteMetadata = await options.remote.metadata(record?.remoteId ?? id, {
                    meta: metadataOptions.meta,
                    select: missing,
                });
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
                });
                record = await mergeBlobMetadata(id, record, localBlob, unresolved, true);
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

        async stage(id, blob) {
            await store.stage(id, blob);
        },

        metadata(id, metadataOptions) {
            return resolveMetadata(id, metadataOptions);
        },

        read: readBytes,

        async bindRemoteId(localId, remoteId) {
            await store.bindRemoteId(localId, remoteId);
        },

        cleanup() {
            cleanupPromise ??= Promise.resolve(lifetime.halt())
                .catch(ignoreEffectionHalt)
                .then(() => {
                    return store.cleanup();
                });
            return cleanupPromise;
        },
    };
}
