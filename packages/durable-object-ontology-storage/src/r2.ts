import {
    BlobBytes,
    byteIO,
    byteChunks,
    byteSource,
    type ByteInput,
} from "@party-stack/ontology-storage/blobs";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Effect, Exit, Layer, Stream } from "effect";
import { hashKeyPart, r2Prefix, r2InstallationPrefix } from "./r2Keys.js";
import type { ReadWriteBucketClient } from "alchemy/Cloudflare/R2/ReadWriteBucket";

export interface R2BytesOptions {
    readonly bucket: ReadWriteBucketClient;
    readonly installationId: string;
    readonly ontologyId: string;
}

/** Resolve Alchemy's runtime binding once, without capturing a request's Scope. */
export const makeR2Bytes = Effect.fn("DurableObjectStorage.r2Bytes")(function* (options: R2BytesOptions) {
    const runtime = yield* RuntimeContext;
    const captured = yield* Effect.context<never>();
    const prefix = yield* Effect.promise(() => r2Prefix(options));
    const key = (id: string) => Effect.promise(async () => `${prefix}${await hashKeyPart(id)}`);
    const run = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>) =>
        effect.pipe(Effect.provideService(RuntimeContext, runtime));
    return BlobBytes.of({
        read: Effect.fn("DurableObjectStorage.readBytes")(function* (id: string) {
            const object = yield* run(options.bucket.get(yield* key(id)));
            if (!object) return undefined;
            return {
                size: object.size,
                type: object.httpMetadata?.contentType ?? "application/octet-stream",
                stream: object.body,
            };
        }),
        write: Effect.fn("DurableObjectStorage.writeBytes")(function* (id: string, input: ByteInput) {
            const source = byteSource(input);
            const objectKey = yield* key(id);
            if (source.size === 0) {
                yield* Stream.runDrain(byteChunks(source));
                yield* run(
                    options.bucket.put(objectKey, new ArrayBuffer(0), {
                        httpMetadata: { contentType: source.type || "application/octet-stream" },
                    })
                ).pipe(Effect.uninterruptible);
                return;
            }
            const size = source.size;
            if (size !== undefined) {
                yield* byteIO(async (signal) => {
                    const readable = Stream.toReadableStreamWith(byteChunks(source), captured, { signal });
                    try {
                        const body = Stream.fromReadableStream({
                            evaluate: () => readable,
                            onError: (cause) => cause,
                        });
                        await Effect.runPromiseWith(captured)(
                            run(
                                options.bucket.put(objectKey, body, {
                                    contentLength: size,
                                    httpMetadata: { contentType: source.type || "application/octet-stream" },
                                })
                            ).pipe(Effect.uninterruptible)
                        );
                    } finally {
                        if (!readable.locked) await readable.cancel().catch(() => undefined);
                    }
                });
                return;
            }
            // Bounded multipart buffering supports inputs whose final size is not known yet.
            // Upload IDs are private to this write; resumability across restarts is separate.
            const upload = yield* run(
                options.bucket.createMultipartUpload(objectKey, {
                    httpMetadata: { contentType: source.type || "application/octet-stream" },
                })
            );
            const parts: { partNumber: number; etag: string }[] = [];
            const capacity = 8 * 1024 * 1024;
            let buffer = new Uint8Array(capacity);
            let used = 0;
            const flush = Effect.fnUntraced(function* () {
                if (!used) return;
                if (parts.length >= 10_000)
                    return yield* Effect.fail(new RangeError("R2 multipart part limit exceeded."));
                const part = yield* upload
                    .uploadPart(parts.length + 1, buffer.subarray(0, used))
                    .pipe(Effect.uninterruptible);
                parts.push(part);
                buffer = new Uint8Array(capacity);
                used = 0;
            });
            yield* Effect.gen(function* () {
                yield* Stream.runForEach(byteChunks(source), (chunk) =>
                    Effect.gen(function* () {
                        let offset = 0;
                        while (offset < chunk.length) {
                            const count = Math.min(capacity - used, chunk.length - offset);
                            buffer.set(chunk.subarray(offset, offset + count), used);
                            used += count;
                            offset += count;
                            if (used === capacity) yield* flush();
                        }
                    })
                );
                yield* flush();
                if (parts.length) yield* upload.complete(parts).pipe(Effect.uninterruptible);
                else {
                    yield* upload.abort().pipe(Effect.uninterruptible);
                    yield* run(
                        options.bucket.put(objectKey, new ArrayBuffer(0), {
                            httpMetadata: { contentType: source.type || "application/octet-stream" },
                        })
                    ).pipe(Effect.uninterruptible);
                }
            }).pipe(
                Effect.onExit((exit) =>
                    Exit.isSuccess(exit) ? Effect.void : upload.abort().pipe(Effect.catch(() => Effect.void))
                )
            );
        }),
        delete: Effect.fn("DurableObjectStorage.deleteBytes")(function* (id: string) {
            yield* run(options.bucket.delete(yield* key(id)));
        }),
    });
});

/** Supply the Alchemy R2 client independently of ontology execution. */
export const r2BytesLayer = (options: R2BytesOptions) => Layer.effect(BlobBytes, makeR2Bytes(options));

/** Run from an exclusive lifecycle gate, after closing all users of this DO's storage. */
export const destroyDurableObjectOntologyStorage = Effect.fn("DurableObjectStorage.destroy")(
    function* (options: {
        readonly storage: { deleteAll(): Promise<void> };
        readonly bucket: ReadWriteBucketClient;
        readonly installationId: string;
        readonly quiesce: Effect.Effect<void>;
    }) {
        yield* options.quiesce;
        const prefix = yield* Effect.promise(() => r2InstallationPrefix(options.installationId));
        let cursor: string | undefined;
        do {
            const listed = yield* options.bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
            const keys = listed.objects.map((object) => object.key);
            if (keys.length) yield* options.bucket.delete(keys);
            cursor = listed.truncated ? listed.cursor : undefined;
        } while (cursor);
        yield* Effect.promise(() => options.storage.deleteAll());
    }
);
