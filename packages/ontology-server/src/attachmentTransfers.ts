import { BackendError } from "@party-stack/ontology-backend";
import { byteSource, byteChunks, type ByteInput } from "@party-stack/ontology-storage/blobs";
import { Effect, Queue, Schema, Semaphore, Stream } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { RpcActivity } from "./rpcActivity.js";
import type { Headers } from "effect/http/Headers";

export const attachmentChunkSize = 64 * 1024;
const Counter = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
export const Attachment = Schema.Struct({
    id: Schema.NonEmptyString,
    type: Schema.optional(Schema.String),
    source: Schema.optional(
        Schema.Struct({
            objectType: Schema.String,
            primaryKey: Schema.Union([Schema.String, Schema.Number]),
            property: Schema.String,
        })
    ),
});
export const Target = Schema.Union([
    Schema.Struct({
        kind: Schema.Literal("objectProperty"),
        objectType: Schema.String,
        property: Schema.String,
    }),
    Schema.Struct({
        kind: Schema.Literal("actionParameter"),
        actionType: Schema.String,
        parameter: Schema.String,
    }),
]);
export const AttachmentUploadSchema = Schema.Struct({
    size: Schema.optional(Counter),
    type: Schema.String,
    name: Schema.optional(Schema.String),
    id: Schema.optional(Schema.NonEmptyString),
    target: Schema.optional(Target),
    eager: Schema.optional(Schema.Boolean),
});
const Chunk = Schema.Struct({
    uploadId: Schema.NonEmptyString,
    sequence: Counter,
    bytes: Schema.Uint8ArrayFromBase64.check(Schema.isMaxLength(attachmentChunkSize)),
    end: Schema.Boolean,
});
const UploadEvent = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("ready"), uploadId: Schema.NonEmptyString }),
    Schema.Struct({ kind: Schema.Literal("complete"), attachment: Attachment }),
]);
const DownloadEvent = Schema.Union([
    Schema.Struct({
        kind: Schema.Literal("metadata"),
        type: Schema.String,
        size: Schema.optional(Counter),
        name: Schema.optional(Schema.String),
    }),
    Schema.Struct({ kind: Schema.Literal("bytes"), bytes: Schema.Uint8ArrayFromBase64 }),
]);

/** RPC streams responses. Upload chunks use acknowledged calls beneath a scoped response stream. */
export const AttachmentTransferRpcs = RpcGroup.make(
    Rpc.make("CreateAttachment", {
        payload: AttachmentUploadSchema,
        success: UploadEvent,
        error: BackendError,
        stream: true,
    }).annotate(RpcActivity, "transfer"),
    Rpc.make("WriteAttachmentChunk", { payload: Chunk, error: BackendError }),
    Rpc.make("ReadAttachment", {
        payload: Attachment,
        success: DownloadEvent,
        error: BackendError,
        stream: true,
    }).annotate(RpcActivity, "transfer")
);
export type AttachmentUpload = Schema.Schema.Type<typeof AttachmentUploadSchema>;
export type AttachmentValue = Schema.Schema.Type<typeof Attachment>;
type Frame = Pick<Schema.Schema.Type<typeof Chunk>, "bytes" | "end">;
const rejected = (message: string) =>
    new BackendError({
        operation: "attachment.transfer",
        kind: "ValidationFailed",
        message,
        retryable: false,
    });

export interface AttachmentTransferPolicy<R = never> {
    /** For custom authentication, return the stable authenticated principal + form/revision scope. */
    uploadOwner?: (headers: Headers) => Effect.Effect<string, BackendError, R>;
    limits?: {
        maxBytes?: number;
        maxConcurrent?: number;
        maxPerOwner?: number;
        maxReservedBytes?: number;
        idleTimeoutMs?: number;
        maxDurationMs?: number;
    };
}

export const attachmentTransferHandlers = <R>(
    options: AttachmentTransferPolicy<R> & {
        authorizeUpload(request: AttachmentUpload, headers: Headers): Effect.Effect<void, BackendError, R>;
        create(request: AttachmentUpload, blob: ByteInput): Effect.Effect<AttachmentValue, BackendError, R>;
        read(attachment: AttachmentValue, headers: Headers): Effect.Effect<ByteInput, BackendError, R>;
    }
) => {
    const uploads = new Map<
        string,
        {
            request: AttachmentUpload;
            owner: string;
            clientId: number;
            reserved: number;
            queue: Queue.Queue<Frame, BackendError>;
            gate: Semaphore.Semaphore;
            sequence: number;
            size: number;
            ended: boolean;
        }
    >();
    const limits = {
        maxBytes: 1024 * 1024 * 1024,
        maxConcurrent: 8,
        maxPerOwner: 2,
        maxReservedBytes: 4 * 1024 * 1024 * 1024,
        idleTimeoutMs: 60_000,
        maxDurationMs: 30 * 60_000,
        ...options.limits,
    };
    for (const value of Object.values(limits))
        if (!Number.isSafeInteger(value) || value <= 0)
            throw new RangeError("Invalid attachment transfer limits.");
    const owner =
        options.uploadOwner ??
        ((headers: Headers) =>
            Effect.tryPromise(async () => {
                const hash = await crypto.subtle.digest(
                    "SHA-256",
                    new TextEncoder().encode(
                        JSON.stringify([headers.authorization ?? "", headers.cookie ?? ""])
                    )
                );
                return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(
                    ""
                );
            }).pipe(Effect.mapError(() => rejected("Cannot identify attachment transfer owner."))));
    const limited = () =>
        new BackendError({
            operation: "attachment.transfer",
            kind: "RateLimited",
            message: "Attachment transfer capacity is in use.",
            retryable: true,
        });
    return AttachmentTransferRpcs.toLayer({
        CreateAttachment: (request, context) =>
            Stream.unwrap(
                Effect.gen(function* () {
                    yield* Effect.annotateCurrentSpan("activity", "transfer");
                    yield* options.authorizeUpload(request, context.headers);
                    if (request.size !== undefined && request.size > limits.maxBytes)
                        return yield* rejected("Attachment exceeds the configured upload limit.");
                    const principal = yield* owner(context.headers);
                    const id = crypto.randomUUID();
                    const queue = yield* Queue.bounded<Frame, BackendError>(1);
                    const transfer = {
                        request,
                        owner: principal,
                        clientId: context.client.id,
                        reserved: request.size ?? limits.maxBytes,
                        queue,
                        gate: yield* Semaphore.make(1),
                        sequence: 0,
                        size: 0,
                        ended: false,
                    };
                    yield* Effect.acquireRelease(
                        Effect.gen(function* () {
                            const active = [...uploads.values()];
                            if (
                                active.length >= limits.maxConcurrent ||
                                active.filter((item) => item.owner === principal).length >=
                                    limits.maxPerOwner ||
                                active.reduce((total, item) => total + item.reserved, transfer.reserved) >
                                    limits.maxReservedBytes
                            )
                                return yield* limited();
                            uploads.set(id, transfer);
                        }),
                        () =>
                            Effect.sync(() => {
                                uploads.delete(id);
                                Queue.shutdownUnsafe(queue);
                            })
                    );
                    const consume = Effect.gen(function* () {
                        const stream = Stream.fromQueue(queue).pipe(
                            Stream.timeout(limits.idleTimeoutMs),
                            Stream.mapError((cause) =>
                                cause instanceof BackendError
                                    ? cause
                                    : rejected("Attachment transfer timed out.")
                            ),
                            Stream.takeUntil((frame) => frame.end),
                            Stream.map((frame) => frame.bytes)
                        );
                        const attachment = yield* options.create(request, {
                            stream,
                            size: request.size,
                            type: request.type,
                            name: request.name,
                        });
                        if (!transfer.ended)
                            return yield* rejected("Attachment writer returned before the upload finished.");
                        return {
                            kind: "complete" as const,
                            attachment,
                        };
                    });
                    return Stream.concat(
                        Stream.succeed({ kind: "ready" as const, uploadId: id }),
                        Stream.fromEffect(
                            consume.pipe(
                                Effect.timeout(limits.maxDurationMs),
                                Effect.catchTag("TimeoutError", () =>
                                    Effect.fail(
                                        new BackendError({
                                            operation: "attachment.transfer",
                                            kind: "Unavailable",
                                            message: "Attachment transfer deadline expired.",
                                            retryable: true,
                                        })
                                    )
                                )
                            )
                        )
                    );
                })
            ),
        WriteAttachmentChunk: (request, context) =>
            Effect.gen(function* () {
                const transfer = uploads.get(request.uploadId);
                if (!transfer) return yield* rejected("The attachment transfer has ended.");
                if (
                    transfer.clientId !== context.client.id ||
                    transfer.owner !== (yield* owner(context.headers))
                )
                    return yield* new BackendError({
                        operation: "attachment.transfer",
                        kind: "Forbidden",
                        message: "Attachment transfer is unavailable.",
                        retryable: false,
                    });
                yield* transfer.gate.withPermits(1)(
                    Effect.gen(function* () {
                        if (
                            transfer.ended ||
                            request.sequence !== transfer.sequence ||
                            transfer.size + request.bytes.length > limits.maxBytes ||
                            (transfer.request.size !== undefined &&
                                transfer.size + request.bytes.length > transfer.request.size) ||
                            (request.end &&
                                transfer.request.size !== undefined &&
                                transfer.size + request.bytes.length !== transfer.request.size)
                        ) {
                            const error = rejected("Invalid attachment chunk sequence or size.");
                            yield* Queue.fail(transfer.queue, error);
                            return yield* error;
                        }
                        if (request.end)
                            yield* options
                                .authorizeUpload(transfer.request, context.headers)
                                .pipe(Effect.tapError((error) => Queue.fail(transfer.queue, error)));
                        transfer.sequence++;
                        transfer.size += request.bytes.length;
                        transfer.ended = request.end;
                        if (!(yield* Queue.offer(transfer.queue, { bytes: request.bytes, end: request.end })))
                            return yield* rejected("The attachment transfer has ended.");
                    })
                );
            }),
        ReadAttachment: (attachment, context) =>
            Stream.unwrap(
                Effect.gen(function* () {
                    yield* Effect.annotateCurrentSpan("activity", "transfer");
                    const blob = byteSource(yield* options.read(attachment, context.headers));
                    const metadata = {
                        kind: "metadata" as const,
                        type: blob.type,
                        size: blob.size,
                        name: blob.name,
                    };
                    const bytes = byteChunks(blob).pipe(
                        Stream.mapError((cause) =>
                            cause instanceof BackendError
                                ? cause
                                : new BackendError({
                                      operation: "attachment.read",
                                      kind: "Unavailable",
                                      message: "Attachment stream failed.",
                                      retryable: true,
                                      cause,
                                  })
                        ),
                        Stream.map((bytes) => ({ kind: "bytes" as const, bytes }))
                    );
                    return Stream.concat(Stream.succeed(metadata), bytes);
                })
            ),
    });
};

export function* splitAttachmentChunk(bytes: Uint8Array) {
    for (let offset = 0; offset < bytes.length; offset += attachmentChunkSize)
        yield bytes.subarray(offset, offset + attachmentChunkSize);
}
