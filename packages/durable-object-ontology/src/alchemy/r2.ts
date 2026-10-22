import { BlobBytes } from "@party-stack/ontology-storage/blobs";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Effect, Layer, Stream } from "effect";
import { hashKeyPart, r2Prefix } from "../r2Keys.js";
import type { ReadWriteBucketClient } from "alchemy/Cloudflare/R2/ReadWriteBucket";

export interface AlchemyR2BytesOptions {
    readonly bucket: ReadWriteBucketClient;
    readonly installationId: string;
    readonly ontologyId: string;
}

/** Resolve Alchemy's runtime binding once, without capturing a request's Scope. */
export const makeAlchemyR2Bytes = Effect.fn("AlchemyOntology.r2Bytes")(function* (
    options: AlchemyR2BytesOptions
) {
    const runtime = yield* RuntimeContext;
    const prefix = yield* Effect.promise(() => r2Prefix(options));
    const key = (id: string) => Effect.promise(async () => `${prefix}${await hashKeyPart(id)}`);
    const run = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>) =>
        effect.pipe(Effect.provideService(RuntimeContext, runtime));
    return BlobBytes.of({
        read: Effect.fn("AlchemyOntology.readBytes")(function* (id: string) {
            const object = yield* run(options.bucket.get(yield* key(id)));
            if (!object) return undefined;
            return new Blob([yield* object.arrayBuffer()], {
                type: object.httpMetadata?.contentType ?? "application/octet-stream",
            });
        }),
        write: Effect.fn("AlchemyOntology.writeBytes")(function* (id: string, blob: Blob) {
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
        delete: Effect.fn("AlchemyOntology.deleteBytes")(function* (id: string) {
            yield* run(options.bucket.delete(yield* key(id)));
        }),
    });
});

/** Optional Alchemy composition; importing the default package does not load Alchemy. */
export const alchemyR2BytesLayer = (options: AlchemyR2BytesOptions) =>
    Layer.effect(BlobBytes, makeAlchemyR2Bytes(options));
