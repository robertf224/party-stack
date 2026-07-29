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
import { BlobBytesUnavailableError, createBlobStore, type BlobStore } from "./store/createBlobStore.js";
import type { BlobManager, BlobManagerOptions, BlobRef, BlobRemoteMetadata } from "./types.js";

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

function toRemoteMetadata(ref: BlobRef, id = ref.id): BlobRemoteMetadata {
    return {
        id,
        size: ref.size,
        type: ref.type,
        name: ref.name,
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

    const fetchRemote = async (
        id: string,
        ref: BlobRef | undefined,
        readOptions: Parameters<BlobManager["read"]>[1]
    ): Promise<Blob> => {
        const remoteId = ref?.remoteId ?? id;
        const [blob, metadata] = await Promise.all([
            options.remote.read(remoteId, readOptions),
            options.remote.metadata(remoteId, readOptions),
        ]);
        const cached = metadata.name
            ? new File([blob], metadata.name, {
                  type: metadata.type || blob.type,
              })
            : new Blob([blob], {
                  type: metadata.type || blob.type,
              });
        await store.cache(ref?.id ?? id, cached);
        return blob;
    };

    let cleanupPromise: Promise<void> | undefined;
    return {
        collection: store.collection,

        stage(id, blob) {
            return store.stage(id, blob);
        },

        async metadata(id, readOptions) {
            const ref = await store.find(id);
            if (ref) return toRemoteMetadata(ref, id);
            return options.remote.metadata(id, readOptions);
        },

        async read(id, readOptions) {
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
        },

        bindRemoteId(localId, remoteId) {
            return store.bindRemoteId(localId, remoteId);
        },

        cleanup() {
            cleanupPromise ??= Promise.resolve(lifetime.halt())
                .catch(ignoreEffectionHalt)
                .then(() => store.cleanup());
            return cleanupPromise;
        },
    };
}
