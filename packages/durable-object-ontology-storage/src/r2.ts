import { BlobBytes } from "@party-stack/ontology-storage/blobs";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Effect, Layer, Stream } from "effect";
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
    const prefix = yield* Effect.promise(() => r2Prefix(options));
    const key = (id: string) => Effect.promise(async () => `${prefix}${await hashKeyPart(id)}`);
    const run = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>) =>
        effect.pipe(Effect.provideService(RuntimeContext, runtime));
    return BlobBytes.of({
        read: Effect.fn("DurableObjectStorage.readBytes")(function* (id: string) {
            const object = yield* run(options.bucket.get(yield* key(id)));
            if (!object) return undefined;
            return new Blob([yield* object.arrayBuffer()], {
                type: object.httpMetadata?.contentType ?? "application/octet-stream",
            });
        }),
        write: Effect.fn("DurableObjectStorage.writeBytes")(function* (id: string, blob: Blob) {
            const body = Stream.fromReadableStream({
                evaluate: () => blob.stream(),
                onError: (cause) => cause,
            });
            yield* run(
                // Alchemy's stream overload rejects a zero contentLength. R2 accepts
                // an empty ArrayBuffer without the stream length bridge.
                options.bucket.put(yield* key(id), blob.size === 0 ? new ArrayBuffer(0) : body, {
                    contentLength: blob.size,
                    httpMetadata: { contentType: blob.type || "application/octet-stream" },
                })
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
