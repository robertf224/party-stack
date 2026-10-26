import { BackendError } from "@party-stack/ontology-backend";
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
const Upload = Schema.Struct({
    size: Counter,
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
        size: Counter,
        name: Schema.optional(Schema.String),
    }),
    Schema.Struct({ kind: Schema.Literal("bytes"), bytes: Schema.Uint8ArrayFromBase64 }),
]);

/** RPC streams responses. Upload chunks use acknowledged calls beneath a scoped response stream. */
export const AttachmentTransferRpcs = RpcGroup.make(
    Rpc.make("CreateAttachment", {
        payload: Upload,
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
export type AttachmentUpload = Schema.Schema.Type<typeof Upload>;
export type AttachmentValue = Schema.Schema.Type<typeof Attachment>;
type Frame = Pick<Schema.Schema.Type<typeof Chunk>, "bytes" | "end">;
const rejected = (message: string) =>
    new BackendError({
        operation: "attachment.transfer",
        kind: "ValidationFailed",
        message,
        retryable: false,
    });

export const attachmentTransferHandlers = <R>(options: {
    authorizeUpload(request: AttachmentUpload, headers: Headers): Effect.Effect<void, BackendError, R>;
    create(request: AttachmentUpload, blob: Blob): Effect.Effect<AttachmentValue, BackendError, R>;
    read(attachment: AttachmentValue, headers: Headers): Effect.Effect<Blob, BackendError, R>;
}) => {
    const uploads = new Map<
        string,
        {
            request: AttachmentUpload;
            queue: Queue.Queue<Frame, BackendError>;
            gate: Semaphore.Semaphore;
            sequence: number;
            size: number;
            ended: boolean;
        }
    >();
    return AttachmentTransferRpcs.toLayer({
        CreateAttachment: (request, context) =>
            Stream.unwrap(
                Effect.gen(function* () {
                    yield* Effect.annotateCurrentSpan("activity", "transfer");
                    yield* options.authorizeUpload(request, context.headers);
                    const id = crypto.randomUUID();
                    const queue = yield* Queue.bounded<Frame, BackendError>(1);
                    const transfer = {
                        request,
                        queue,
                        gate: yield* Semaphore.make(1),
                        sequence: 0,
                        size: 0,
                        ended: false,
                    };
                    yield* Effect.acquireRelease(
                        Effect.sync(() => {
                            uploads.set(id, transfer);
                        }),
                        () =>
                            Effect.sync(() => {
                                uploads.delete(id);
                                Queue.shutdownUnsafe(queue);
                            })
                    );
                    const consume = Effect.gen(function* () {
                        const parts: ArrayBuffer[] = [];
                        for (;;) {
                            const frame = yield* Queue.take(queue);
                            if (frame.bytes.length) parts.push(new Uint8Array(frame.bytes).buffer);
                            if (frame.end) break;
                        }
                        const blob =
                            request.name === undefined
                                ? new Blob(parts, { type: request.type })
                                : new File(parts, request.name, { type: request.type });
                        return {
                            kind: "complete" as const,
                            attachment: yield* options.create(request, blob),
                        };
                    });
                    return Stream.concat(
                        Stream.succeed({ kind: "ready" as const, uploadId: id }),
                        Stream.fromEffect(consume)
                    );
                })
            ),
        WriteAttachmentChunk: (request, context) =>
            Effect.gen(function* () {
                const transfer = uploads.get(request.uploadId);
                if (!transfer) return yield* rejected("The attachment transfer has ended.");
                yield* options.authorizeUpload(transfer.request, context.headers);
                yield* transfer.gate.withPermits(1)(
                    Effect.gen(function* () {
                        if (
                            transfer.ended ||
                            request.sequence !== transfer.sequence ||
                            transfer.size + request.bytes.length > transfer.request.size ||
                            (request.end && transfer.size + request.bytes.length !== transfer.request.size)
                        ) {
                            const error = rejected("Invalid attachment chunk sequence or size.");
                            yield* Queue.fail(transfer.queue, error);
                            return yield* error;
                        }
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
                    const blob = yield* options.read(attachment, context.headers);
                    const metadata = {
                        kind: "metadata" as const,
                        type: blob.type,
                        size: blob.size,
                        name: typeof File !== "undefined" && blob instanceof File ? blob.name : undefined,
                    };
                    const bytes = Stream.fromReadableStream({
                        evaluate: () => blob.stream(),
                        onError: (cause) =>
                            new BackendError({
                                operation: "attachment.read",
                                kind: "Unavailable",
                                message: "Attachment stream failed.",
                                retryable: true,
                                cause,
                            }),
                    }).pipe(
                        Stream.flatMap((chunk) => Stream.fromIterable(splitAttachmentChunk(chunk))),
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
