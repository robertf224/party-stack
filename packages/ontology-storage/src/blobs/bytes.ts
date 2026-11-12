import { sha256 } from "@noble/hashes/sha2.js";
import { Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { blobFailure } from "./model.js";

/** Lazy bytes. Durable sources reopen on every consumption; incoming streams may be one-shot. */
export interface ByteSource {
    readonly stream: Stream.Stream<Uint8Array, unknown>;
    readonly size?: number;
    readonly type: string;
    readonly name?: string;
}

/** Bind acquisition and consumption to both the caller and an optional owner.
 * Closing either interrupts pending IO, including an acquired but unconsumed body.
 * Durable sources may reopen while this read's caller scope remains open.
 */
export const scopedByteSource = Effect.fnUntraced(function* <E, R>(
    acquire: Effect.Effect<ByteSource, E, R>,
    owner?: Scope.Scope
): Effect.fn.Return<ByteSource, E, R | Scope.Scope> {
    const caller = yield* Effect.scope;
    if (caller.state._tag === "Closed") return yield* Effect.interrupt;
    const lifetime = yield* Effect.acquireRelease(Scope.fork(owner ?? caller), (scope, exit) =>
        Scope.close(scope, exit)
    );
    const closed = yield* Deferred.make<void>();
    yield* Scope.addFinalizer(lifetime, Deferred.succeed(closed, undefined));
    const source = yield* Effect.flatMap(
        Effect.forkIn(Scope.provide(acquire, lifetime), lifetime),
        Fiber.join
    ).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(lifetime, exit) : Effect.void)));
    return {
        ...source,
        stream: Stream.suspend(() =>
            lifetime.state._tag === "Closed" ? Stream.fromEffect(Effect.interrupt) : source.stream
        ).pipe(Stream.interruptWhen(Deferred.await(closed).pipe(Effect.andThen(Effect.interrupt)))),
    };
});
export type ByteInput = Blob | ByteSource;
/** Application input. Length can be omitted for recordings and other generated content. */
export interface ReadableByteInput {
    readonly stream: ReadableStream<Uint8Array>;
    readonly size?: number;
    readonly type?: string;
    readonly name?: string;
}
export const attachmentByteSource = (input: ByteInput | ReadableByteInput): ByteSource => {
    if ("arrayBuffer" in input) return byteSource(input);
    return Stream.isStream(input.stream)
        ? (input as ByteSource)
        : readableByteSource(input.stream as ReadableStream<Uint8Array>, input);
};
export const byteChunkSize = 64 * 1024;
/** Explicit bound for APIs that require materializing a Blob. Streaming stores have no such bound. */
export const defaultBlobBufferLimit = 64 * 1024 * 1024;

export const byteSource = (input: ByteInput): ByteSource =>
    "arrayBuffer" in input
        ? {
              size: input.size,
              type: input.type,
              name: "name" in input && typeof input.name === "string" ? input.name : undefined,
              stream: Stream.fromReadableStream({
                  evaluate: () => input.stream(),
                  onError: (cause) => cause,
              }),
          }
        : input;

export const readableByteSource = (
    stream: ReadableStream<Uint8Array>,
    metadata: { readonly size?: number; readonly type?: string; readonly name?: string } = {}
): ByteSource => ({
    ...metadata,
    type: metadata.type ?? "application/octet-stream",
    stream: Stream.fromReadableStream({ evaluate: () => stream, onError: (cause) => cause }),
});

/** Copy bounded frames, so a reused producer buffer cannot mutate retained/uploaded bytes. */
export const byteChunks = (input: ByteInput) =>
    byteSource(input).stream.pipe(
        Stream.flatMap((chunk) =>
            Stream.fromIterable(
                (function* () {
                    for (let offset = 0; offset < chunk.length; offset += byteChunkSize)
                        yield chunk.slice(offset, offset + byteChunkSize);
                })(),
                { chunkSize: 1 }
            )
        )
    );

export const collectByteBlob = Effect.fnUntraced(function* (
    input: ByteInput,
    maxBytes = defaultBlobBufferLimit
) {
    const source = byteSource(input);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
        return yield* blobFailure("InvalidValue", "Invalid byte buffering limit.");
    if (source.size !== undefined && source.size > maxBytes)
        return yield* blobFailure("InvalidValue", "Attachment exceeds this API's byte buffering limit.");
    let size = 0;
    const parts: ArrayBuffer[] = [];
    yield* Stream.runForEach(byteChunks(source), (chunk) =>
        Effect.gen(function* () {
            size += chunk.length;
            if (size > maxBytes)
                return yield* blobFailure(
                    "InvalidValue",
                    "Attachment exceeds this API's byte buffering limit."
                );
            parts.push(new Uint8Array(chunk).buffer);
        })
    );
    if (source.size !== undefined && source.size !== size)
        return yield* blobFailure("InvalidValue", "Attachment byte count does not match its declared size.");
    return source.name === undefined
        ? new Blob(parts, { type: source.type })
        : new File(parts, source.name, { type: source.type });
});

// Effect 4.1's Digest currently accepts a complete Uint8Array. Keep incremental
// hashing here so attachments stay streamed; revisit if Digest gains streaming IO.
/** Content identity for an already materialized portable value. */
export const digestBytesSync = (bytes: Uint8Array): string =>
    Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** A platform SHA-256 over complete bytes, such as Expo Crypto's native digest. */
export type NativeSha256 = (bytes: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer | Uint8Array>;
let nativeSha256: NativeSha256 | undefined;
/** Bound native one-shot hashing; larger or longer inputs keep streaming JavaScript hashing. */
const nativeDigestLimit = 8 * 1024 * 1024;
/** Install a platform digest. Portable JavaScript SHA-256 is far slower on mobile
 * engines (hundreds of milliseconds per MiB on Hermes). Platform runtimes call
 * this from their polyfill; omit it to restore the portable implementation.
 */
export const configureNativeSha256 = (digest: NativeSha256 | undefined) => {
    nativeSha256 = digest;
};
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const digestBytes = Effect.fnUntraced(function* (input: ByteInput) {
    const native = nativeSha256;
    const source = byteSource(input);
    let hash = !native || (source.size ?? 0) > nativeDigestLimit ? sha256.create() : undefined;
    let parts: Uint8Array[] = [];
    let size = 0;
    yield* Stream.runForEach(byteChunks(source), (chunk) =>
        Effect.sync(() => {
            if (hash) return hash.update(chunk);
            size += chunk.length;
            if (size <= nativeDigestLimit) return parts.push(chunk);
            // An unknown-size stream exceeded the bound: continue incrementally.
            hash = sha256.create();
            for (const part of parts) hash.update(part);
            parts = [];
            hash.update(chunk);
        })
    );
    if (hash) return hex(hash.digest());
    if (!native) return hex(sha256.create().digest());
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
    }
    const digest = yield* Effect.tryPromise(() => native(bytes));
    return hex(new Uint8Array(digest));
});

/** Portable fallback until a byte driver/provider exposes native range reads. */
export const sliceByteSource = (input: ByteInput, offset = 0, length?: number): ByteSource => {
    const source = byteSource(input);
    return {
        ...source,
        size:
            source.size === undefined
                ? undefined
                : Math.min(Math.max(0, source.size - offset), length ?? Infinity),
        stream: Stream.suspend(() => {
            if (
                !Number.isSafeInteger(offset) ||
                offset < 0 ||
                (length !== undefined && (!Number.isSafeInteger(length) || length < 0))
            )
                return Stream.fail(blobFailure("InvalidValue", "Invalid attachment byte range."));
            if (length === 0) return Stream.empty;
            let position = 0;
            return byteChunks(source).pipe(
                Stream.map((chunk) => {
                    const start = Math.max(0, offset - position);
                    const end = Math.min(chunk.length, offset + (length ?? Infinity) - position);
                    position += chunk.length;
                    return chunk.subarray(start, Math.max(start, end));
                }),
                Stream.takeUntil(() => position >= offset + (length ?? Infinity))
            );
        }),
    };
};

/** Cancel platform IO, then wait for it to settle before storage abandons its immutable key. */
export const byteIO = <A>(run: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, unknown> =>
    Effect.callback<A, unknown>((resume) => {
        const controller = new AbortController();
        const task = Promise.resolve().then(() => run(controller.signal));
        void task.then(
            (value) => resume(Effect.succeed(value)),
            (error) => resume(Effect.fail(error))
        );
        return Effect.promise(async () => {
            controller.abort();
            await task.catch(() => undefined);
        });
    });
