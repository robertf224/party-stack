import { sha256 } from "@noble/hashes/sha2.js";
import { Effect, Stream } from "effect";
import { blobFailure } from "./model.js";

/** Lazy bytes. Durable sources reopen on every consumption; incoming streams may be one-shot. */
export interface ByteSource {
    readonly stream: Stream.Stream<Uint8Array, unknown>;
    readonly size?: number;
    readonly type: string;
    readonly name?: string;
}
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

export const digestBytes = Effect.fnUntraced(function* (input: ByteInput) {
    const hash = sha256.create();
    yield* Stream.runForEach(byteChunks(input), (chunk) => Effect.sync(() => hash.update(chunk)));
    return Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
