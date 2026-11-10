import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import {
    byteSource,
    byteChunks,
    collectByteBlob,
    scopedByteSource,
    type BlobStorageService,
    type BlobRecord,
    type ByteInput,
    type ByteSource,
} from "@party-stack/ontology-storage/blobs";
import { Effect, Exit, Fiber, RcMap, Scope, Semaphore, Stream, Queue } from "effect";
import { measureBlobDimensions } from "./dimensions.js";
import type { BlobReadOptions, BlobMetadataOptions, PartialBlobMetadata } from "./types.js";

export interface BlobManagerService {
    readonly storage: BlobStorageService;
    readonly stage: (id: string, input: ByteInput) => Effect.Effect<void, BackendError>;
    readonly bindRemoteId: (id: string, remoteId: string) => Effect.Effect<void, BackendError>;
    readonly source: (
        id: string,
        options?: BlobReadOptions
    ) => Effect.Effect<ByteSource, BackendError, Scope.Scope>;
    readonly read: (id: string, options?: BlobReadOptions) => Effect.Effect<Blob, BackendError>;
    readonly metadata: (
        id: string,
        options?: BlobMetadataOptions
    ) => Effect.Effect<PartialBlobMetadata & { id: string }, BackendError>;
}
export interface BlobManagerOptions {
    readonly gcTime?: number;
    readonly budget?: { readonly maxBytes?: number; readonly targetBytes?: number };
    readonly sweepIntervalMs?: number;
    readonly remote: {
        readonly read: (
            id: string,
            options?: BlobReadOptions
        ) => Effect.Effect<ByteInput, BackendError, Scope.Scope>;
        readonly metadata?: (
            id: string,
            options?: BlobMetadataOptions
        ) => Effect.Effect<PartialBlobMetadata, BackendError>;
    };
}
const failure = (cause: unknown) => classifyBackendFailure("attachment.storage", cause);
const boundary = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.mapError(failure));
const pickMetadata = (record: BlobRecord | undefined): PartialBlobMetadata =>
    record ? { size: record.size, type: record.type, name: record.name, dimensions: record.dimensions } : {};
const awaitAbort = (signal: AbortSignal) =>
    Effect.callback<never>((resume) => {
        const abort = () => resume(Effect.interrupt);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        return Effect.sync(() => signal.removeEventListener("abort", abort));
    });
const abortable = (stream: Stream.Stream<Uint8Array, unknown>, signal?: AbortSignal) =>
    signal
        ? Stream.unwrap(
              Effect.suspend(() =>
                  signal.aborted
                      ? Effect.interrupt
                      : Effect.succeed(stream.pipe(Stream.interruptWhen(awaitAbort(signal))))
              )
          )
        : stream;

/** Native acquisition and IO. The host scope joins all reads, writes and maintenance;
 * only the outer application client converts these Effects to Promises.
 */
export const makeBlobManagerFromStorage = Effect.fn("BlobManager.make")(function* (
    options: BlobManagerOptions & { readonly storage: BlobStorageService }
): Effect.fn.Return<BlobManagerService, BackendError, Scope.Scope> {
    const owner = yield* Scope.fork(yield* Effect.scope);
    const gcTime = options.gcTime ?? Infinity;
    if (Number.isNaN(gcTime) || gcTime < 0)
        return yield* new BackendError({
            operation: "attachment.configure",
            kind: "InvalidConfiguration",
            message: "Blob cache GC time must be non-negative.",
            retryable: false,
        });
    return yield* Scope.provide(
        Effect.gen(function* () {
            let closed = false;
            yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                    closed = true;
                })
            );
            const cachePressure = yield* Queue.sliding<void>(1);
            yield* Effect.addFinalizer(() => Queue.shutdown(cachePressure));
            const nativeStorage = options.storage;
            const wakePressure =
                options.budget?.maxBytes === undefined
                    ? Effect.void
                    : Queue.offer(cachePressure, undefined).pipe(Effect.asVoid);
            const storage: BlobStorageService = {
                ...nativeStorage,
                stage: (id, input) => nativeStorage.stage(id, input).pipe(Effect.tap(() => wakePressure)),
                cache: (id, input) => nativeStorage.cache(id, input).pipe(Effect.tap(() => wakePressure)),
            };
            const owned = <A, R>(work: Effect.Effect<A, BackendError, R>) =>
                Effect.suspend(() =>
                    closed
                        ? Effect.fail(
                              new BackendError({
                                  operation: "attachment.lifecycle",
                                  kind: "InvalidRequest",
                                  message: "Blob manager is closed.",
                                  retryable: false,
                              })
                          )
                        : Effect.acquireUseRelease(Effect.forkIn(work, owner), Fiber.join, Fiber.interrupt)
                );
            const reads = yield* RcMap.make({ lookup: () => Semaphore.make(1) });
            const collect =
                gcTime === Infinity && options.budget?.maxBytes === undefined
                    ? Effect.void
                    : boundary(
                          storage.collectGarbage({
                              olderThanMs: gcTime === Infinity ? Number.MAX_SAFE_INTEGER : gcTime,
                              ...options.budget,
                          })
                      ).pipe(Effect.asVoid);
            const maintain = boundary(storage.recover).pipe(
                Effect.andThen(collect),
                Effect.catch((error) => Effect.logWarning("Blob maintenance failed", { kind: error.kind }))
            );
            yield* Effect.forkScoped(
                Effect.gen(function* () {
                    yield* maintain;
                    if (gcTime === Infinity && options.budget?.maxBytes === undefined) return;
                    yield* Effect.forever(
                        Effect.raceFirst(
                            Queue.take(cachePressure),
                            Effect.sleep(
                                options.sweepIntervalMs ??
                                    (Number.isFinite(gcTime) ? Math.max(10, gcTime) : 60_000)
                            )
                        ).pipe(Effect.andThen(maintain))
                    );
                })
            );
            const ownedStream = (stream: Stream.Stream<Uint8Array, unknown>) =>
                Stream.unwrap(
                    Effect.gen(function* () {
                        if (closed)
                            return yield* new BackendError({
                                operation: "attachment.lifecycle",
                                kind: "InvalidRequest",
                                message: "Blob manager is closed.",
                                retryable: false,
                            });
                        const scope = yield* Scope.fork(owner);
                        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
                        const queue = yield* Scope.provide(Stream.toQueue(stream, { capacity: 2 }), scope);
                        return Stream.fromQueue(queue);
                    })
                );
            const localSource = Effect.fnUntraced(function* (
                id: string,
                settings?: BlobReadOptions
            ): Effect.fn.Return<ByteSource, BackendError> {
                const record = yield* boundary(storage.metadata(id));
                return {
                    size: record?.size,
                    type: record?.type ?? "application/octet-stream",
                    name: record?.name ?? undefined,
                    stream: abortable(
                        ownedStream(
                            Stream.unwrap(
                                Effect.gen(function* () {
                                    const local = yield* boundary(storage.readScoped(id));
                                    if (local) return local.stream;
                                    if (record?.state === "staged")
                                        return yield* new BackendError({
                                            operation: "attachment.read",
                                            kind: "NotFound",
                                            message: "Staged attachment bytes are unavailable.",
                                            retryable: false,
                                        });
                                    return (yield* source(id, settings)).stream;
                                })
                            )
                        ),
                        settings?.signal
                    ),
                };
            });
            const source = Effect.fnUntraced(function* (
                id: string,
                settings?: BlobReadOptions
            ): Effect.fn.Return<ByteSource, BackendError, Scope.Scope> {
                const record = yield* boundary(storage.metadata(id));
                if (record?.byteKey) return yield* localSource(id, settings);
                if (record?.state === "staged")
                    return yield* new BackendError({
                        operation: "attachment.read",
                        kind: "NotFound",
                        message: "Staged blob bytes are unavailable locally.",
                        retryable: false,
                    });
                const scope = yield* Scope.fork(yield* Effect.scope);
                return yield* Scope.provide(
                    Effect.gen(function* () {
                        const signal = settings?.signal;
                        if (signal) {
                            yield* Effect.acquireRelease(
                                Effect.sync(() => {
                                    const abort = () => {
                                        Effect.runFork(Scope.close(scope, Exit.void));
                                    };
                                    signal.addEventListener("abort", abort, { once: true });
                                    if (signal.aborted) abort();
                                    return () => signal.removeEventListener("abort", abort);
                                }),
                                (remove) => Effect.sync(remove)
                            );
                            if (signal.aborted) return yield* Effect.interrupt;
                        }
                        const lock = yield* RcMap.get(reads, record?.id ?? id);
                        yield* Effect.acquireRelease(lock.take(1), () => lock.release(1));
                        const cached = yield* boundary(storage.readScoped(id));
                        if (cached) {
                            const queue = yield* Stream.toQueue(byteChunks(cached), { capacity: 2 });
                            return {
                                ...cached,
                                stream: abortable(Stream.fromQueue(queue), signal).pipe(
                                    Stream.ensuring(Scope.close(scope, Exit.void))
                                ),
                            };
                        }
                        const remote = byteSource(
                            yield* options.remote.read(record?.remoteId ?? id, settings)
                        );
                        const [cache, reader] = yield* Stream.broadcastN(byteChunks(remote), {
                            n: 2,
                            capacity: 2,
                        });
                        const writing = yield* Effect.forkScoped(
                            boundary(storage.cache(record?.id ?? id, { ...remote, stream: cache })).pipe()
                        );
                        const delivered = Stream.concat(
                            reader,
                            Stream.fromEffect(Fiber.join(writing)).pipe(Stream.drain)
                        );
                        const queue = yield* Stream.toQueue(delivered, { capacity: 2 });
                        let consumed = false;
                        return {
                            ...remote,
                            stream: Stream.suspend(() => {
                                if (consumed)
                                    return Stream.unwrap(
                                        localSource(id, settings).pipe(Effect.map((local) => local.stream))
                                    );
                                consumed = true;
                                return abortable(Stream.fromQueue(queue), signal).pipe(
                                    Stream.ensuring(Scope.close(scope, Exit.void))
                                );
                            }),
                        };
                    }),
                    scope
                ).pipe(
                    Effect.onExit((exit) =>
                        Exit.isFailure(exit) ? Scope.close(scope, Exit.void) : Effect.void
                    )
                );
            });
            const acquireSource = (id: string, settings?: BlobReadOptions) =>
                scopedByteSource(source(id, settings), owner);
            const read = (id: string, settings?: BlobReadOptions) =>
                Effect.scoped(
                    Effect.flatMap(acquireSource(id, settings), (source) => boundary(collectByteBlob(source)))
                );
            const metadata = Effect.fnUntraced(function* (id: string, settings: BlobMetadataOptions = {}) {
                const select = settings.select ?? ["size", "type", "name"];
                let record = yield* boundary(storage.metadata(id));
                let missing = select.filter((field) => record?.[field] === undefined);
                if (missing.length && record?.state !== "staged" && options.remote.metadata) {
                    const remote = yield* Effect.result(
                        options.remote.metadata(record?.remoteId ?? id, { ...settings, select: missing })
                    );
                    if (remote._tag === "Success")
                        record = yield* boundary(storage.updateMetadata(id, remote.success));
                    else if (remote.failure.kind !== "NotImplemented") return yield* remote.failure;
                }
                missing = select.filter((field) => record?.[field] === undefined);
                if (missing.length) {
                    const blob = yield* read(id, settings);
                    const patch: PartialBlobMetadata = {
                        size: blob.size,
                        type: blob.type,
                        name: "name" in blob && typeof blob.name === "string" ? blob.name : null,
                    };
                    if (missing.includes("dimensions"))
                        patch.dimensions = yield* Effect.tryPromise({
                            try: () => measureBlobDimensions(blob),
                            catch: () => undefined,
                        }).pipe(Effect.catch(() => Effect.succeed(null)));
                    record = yield* boundary(storage.updateMetadata(id, patch));
                }
                return { id, ...pickMetadata(record) };
            });
            return {
                storage,
                stage: (id, input) => owned(boundary(storage.stage(id, input))),
                bindRemoteId: (id, remoteId) => owned(boundary(storage.bindRemoteId(id, remoteId))),
                source: (id, settings) => owned(acquireSource(id, settings)),
                read: (id, settings) => owned(read(id, settings)),
                metadata: (id, settings) => owned(metadata(id, settings)),
            } satisfies BlobManagerService;
        }),
        owner
    );
});
