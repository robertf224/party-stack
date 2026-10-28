import {
    ActionReceiptSchema,
    BackendError,
    backendErrorStatus,
    classifyBackendFailure,
    projectBackendError,
    type ActionRequest,
} from "@party-stack/ontology-backend";
import { ActionRequestSchema, protocolValueCodec } from "@party-stack/ontology-backend/protocol";
import {
    attachmentByteSource,
    byteChunks,
    byteSource,
    collectActionAttachments,
    readableByteSource,
    type ByteInput,
    type ByteSource,
} from "@party-stack/ontology-storage/blobs";
import { Cause, Context, Deferred, Effect, Fiber, Queue, Schema, Stream } from "effect";
import { Headers, HttpClient, HttpClientRequest, Multipart } from "effect/http";
import { Attachment, AttachmentUploadSchema } from "./attachmentTransfers.js";
import { errorContext } from "./errorProjection.js";
import { ontologyAttachmentHandlers, type OntologyOperationOptions } from "./operations.js";
import type { LiveOntology } from "@party-stack/ontology";

const uploadParameter = "attachment-upload";
const actionParameter = "action-upload";
const maxMetadataBytes = 256 * 1024;
const maxFiles = 32;
const Payload = Schema.Struct({
    request: protocolValueCodec(ActionRequestSchema),
    files: Schema.Array(
        Schema.Struct({
            attachment: Attachment,
            size: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
            type: Schema.String,
            name: Schema.optional(Schema.String),
        })
    ).check(Schema.isMinLength(1), Schema.isMaxLength(maxFiles)),
});
const invalid = (message: string) =>
    new BackendError({
        operation: "attachment.http",
        kind: "InvalidRequest",
        message,
        retryable: false,
        actionOutcome: "not-committed",
    });
const failure = (cause: unknown) =>
    cause instanceof BackendError ? cause : classifyBackendFailure("attachment.http", cause);
const status = (kind: BackendError["kind"]) => backendErrorStatus({ kind });
export const isAttachmentHttpRequest = (request: Request) => {
    const url = new URL(request.url);
    return url.searchParams.has(uploadParameter) || url.searchParams.has(actionParameter);
};

/** Byte bodies stay on one HTTP request. No upload registry or cross-request affinity is required. */
export const makeAttachmentHttpHandler = Effect.fnUntraced(function* <R>(
    options: OntologyOperationOptions<R>
) {
    const captured = yield* Effect.context<R>();
    const scope = yield* Effect.scope;
    const handlers = ontologyAttachmentHandlers(options);
    const maxBytes = options.attachmentTransfers?.limits?.maxBytes ?? 1024 * 1024 * 1024;
    const maxTotal = options.attachmentTransfers?.limits?.maxReservedBytes ?? 4 * 1024 * 1024 * 1024;
    const idle = options.attachmentTransfers?.limits?.idleTimeoutMs ?? 60_000;
    const duration = options.attachmentTransfers?.limits?.maxDurationMs ?? 30 * 60_000;
    const authorizeUpload = (metadata: typeof AttachmentUploadSchema.Type, headers: Headers.Headers) =>
        options.authorize({ operation: "CreateAttachment", ...metadata }, headers);
    const checked = (input: ByteInput, complete: Effect.Effect<void, BackendError, R>): ByteSource => {
        const source = byteSource(input);
        let size = 0;
        return {
            ...source,
            stream: Stream.concat(
                byteChunks(source).pipe(
                    Stream.timeout(idle),
                    Stream.mapEffect((chunk) =>
                        Effect.gen(function* () {
                            size += chunk.length;
                            if (size > maxBytes || (source.size !== undefined && size > source.size))
                                return yield* invalid("Attachment exceeds its size limit.");
                            return chunk;
                        })
                    )
                ),
                Stream.fromEffect(
                    Effect.gen(function* () {
                        if (source.size !== undefined && size !== source.size)
                            return yield* invalid("Incomplete attachment upload.");
                        yield* complete;
                    })
                ).pipe(Stream.drain)
            ).pipe(Stream.provideContext(captured)),
        };
    };
    const raw = Effect.fnUntraced(function* (request: Request) {
        if (request.method !== "POST") return yield* invalid("Uploads require POST.");
        const headers = Headers.fromInput(request.headers);
        const url = new URL(request.url);
        if (url.searchParams.has(uploadParameter)) {
            const metadataText = url.searchParams.get(uploadParameter)!;
            if (metadataText.length > 16_384) return yield* invalid("Upload metadata is too large.");
            const metadata = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AttachmentUploadSchema))(
                metadataText
            ).pipe(Effect.mapError(() => invalid("Invalid upload metadata.")));
            if (metadata.size !== undefined && metadata.size > maxBytes)
                return yield* invalid("Attachment exceeds its size limit.");
            yield* authorizeUpload(metadata, headers);
            const source = checked(
                readableByteSource(request.body ?? new Blob([]).stream(), metadata),
                authorizeUpload(metadata, headers)
            );
            const attachment = yield* handlers.create(metadata, source);
            return Response.json(Schema.encodeSync(Attachment)(attachment));
        }
        const backend = options.backend;
        const ir = options.ir ?? options.ontology?.ir;
        if (!backend || !ir)
            return yield* new BackendError({
                operation: "applyAction",
                kind: "NotImplemented",
                message: "Multipart actions require a native backend and its ontology definition.",
                retryable: false,
            });
        const requestContext = yield* Effect.context<R | import("effect").Scope.Scope>();
        const result = yield* Deferred.make<
            import("@party-stack/ontology-backend").ActionReceipt,
            BackendError
        >();
        let payload: typeof Payload.Type | undefined;
        let queues: Queue.Queue<Uint8Array, BackendError | Cause.Done>[] = [];
        let nextFile = 0;
        let total = 0;
        const parse = Stream.fromReadableStream({
            evaluate: () => request.body ?? new Blob([]).stream(),
            onError: failure,
        }).pipe(
            Stream.pipeThroughChannel(Multipart.makeChannel(headers)),
            Stream.mapError((cause) =>
                cause instanceof BackendError ? cause : invalid("Invalid multipart action body.")
            )
        );
        const producer = Effect.gen(function* () {
            yield* Stream.runForEach(parse, (part) =>
                Effect.gen(function* () {
                    if (part._tag === "Field") {
                        if (payload || part.key !== "payload")
                            return yield* invalid("Expected one action payload before files.");
                        payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Payload))(
                            part.value
                        ).pipe(Effect.mapError(() => invalid("Invalid multipart action payload.")));
                        const ids = payload.files.map((file) => file.attachment.id);
                        if (new Set(ids).size !== ids.length)
                            return yield* invalid("Duplicate action attachment ID.");
                        const references = new Map(
                            collectActionAttachments(
                                ir,
                                payload.request.name,
                                payload.request.parameters
                            ).map((reference) => [reference.attachment.id, reference])
                        );
                        if (ids.some((id) => !references.has(id)))
                            return yield* invalid("An upload is not referenced by the action parameters.");
                        yield* options.authorize(
                            { operation: "ApplyAction", invocation: payload.request },
                            headers
                        );
                        queues = yield* Effect.forEach(payload.files, () =>
                            Queue.bounded<Uint8Array, BackendError | Cause.Done>(1)
                        );
                        yield* Effect.addFinalizer(() =>
                            Effect.forEach(queues, Queue.shutdown, { discard: true })
                        );
                        const invocation = {
                            ...payload.request,
                            attachmentUploads: payload.files.map((file, index) => ({
                                ...references.get(file.attachment.id)!,
                                blob: checked(
                                    {
                                        size: file.size,
                                        type: file.type,
                                        name: file.name,
                                        stream: Stream.fromQueue(queues[index]!),
                                    },
                                    Effect.void
                                ),
                            })),
                        };
                        yield* Effect.forkScoped(
                            backend.applyAction(invocation).pipe(
                                Effect.exit,
                                Effect.flatMap((exit) => Deferred.done(result, exit))
                            )
                        );
                        return;
                    }
                    if (!payload || nextFile >= queues.length || part.key !== `file-${nextFile}`)
                        return yield* invalid("Unexpected multipart attachment part.");
                    const index = nextFile++;
                    yield* Stream.runForEach(
                        byteChunks({ type: part.contentType, stream: part.content }),
                        (bytes) =>
                            Effect.gen(function* () {
                                total += bytes.length;
                                if (total > maxTotal)
                                    return yield* invalid("Action attachments exceed the total byte limit.");
                                if (!(yield* Queue.offer(queues[index]!, bytes)))
                                    return yield* invalid("The action upload has ended.");
                            })
                    );
                    // Withhold the final EOF until the entire multipart body and final authorization pass.
                    // Providers cannot dispatch the action while an extra/malformed trailing part remains.
                    if (index < queues.length - 1) yield* Queue.end(queues[index]!);
                })
            );
            if (!payload || nextFile !== queues.length)
                return yield* invalid("Incomplete action attachment list.");
            yield* options.authorize({ operation: "ApplyAction", invocation: payload.request }, headers);
            yield* Queue.end(queues.at(-1)!);
        }).pipe(
            Effect.provideContext(
                Context.merge(
                    requestContext,
                    Multipart.limitsServices({
                        maxParts: maxFiles + 1,
                        maxFieldSize: maxMetadataBytes,
                        maxFileSize: maxBytes,
                        maxTotalSize: maxTotal + maxMetadataBytes + maxFiles * 1024,
                    })
                )
            ),
            Effect.tapError((error) => Deferred.fail(result, failure(error)))
        );
        const pump = yield* Effect.forkScoped(producer);
        const receipt = yield* Deferred.await(result);
        yield* Fiber.join(pump);
        return Response.json(Schema.encodeSync(ActionReceiptSchema)(receipt));
    });
    return (request: Request) =>
        Effect.runPromiseWith(captured)(
            Effect.acquireUseRelease(
                Effect.forkIn(
                    Effect.scoped(raw(request)).pipe(
                        Effect.timeout(duration),
                        Effect.mapError(failure),
                        Effect.catchDefect(() =>
                            Effect.fail(
                                new BackendError({
                                    operation: "attachment.http",
                                    kind: "Internal",
                                    message: "Upload could not be completed.",
                                    retryable: false,
                                })
                            )
                        )
                    ),
                    scope
                ),
                Fiber.join,
                Fiber.interrupt
            ).pipe(
                Effect.catch((error) =>
                    Effect.sync(() => {
                        const projected = projectBackendError(error, options.errors, errorContext(options));
                        return Response.json(Schema.encodeSync(BackendError)(projected), {
                            status: status(projected.kind),
                        });
                    }).pipe(
                        Effect.catchDefect(() =>
                            Effect.succeed(
                                Response.json(
                                    Schema.encodeSync(BackendError)(
                                        new BackendError({
                                            operation: "attachment.http",
                                            kind: "Internal",
                                            message: "The operation could not be completed.",
                                            retryable: false,
                                            actionOutcome: "unknown",
                                        })
                                    ),
                                    { status: 500 }
                                )
                            )
                        )
                    )
                )
            ),
            { signal: request.signal }
        );
});

/** The HTTP transport shares its configured Effect HttpClient (credentials, tracing, cancellation). */
export const makeHttpAttachmentClient = Effect.fnUntraced(function* (url: string): Effect.fn.Return<
    {
        readonly create: LiveOntology["attachments"]["create"];
        readonly applyAction: (
            request: ActionRequest
        ) => Effect.Effect<import("@party-stack/ontology-backend").ActionReceipt, BackendError>;
    },
    never,
    HttpClient.HttpClient | import("effect").Scope.Scope
> {
    const http = yield* HttpClient.HttpClient;
    const captured = yield* Effect.context<never>();
    const scope = yield* Effect.scope;
    const execute = Effect.fnUntraced(function* <A, I>(
        request: HttpClientRequest.HttpClientRequest,
        schema: Schema.Codec<A, I>
    ) {
        const response = yield* http.execute(request).pipe(Effect.mapError(failure));
        const data = yield* response.json.pipe(Effect.mapError(failure));
        if (response.status < 200 || response.status >= 300) {
            const error = yield* Schema.decodeUnknownEffect(BackendError)(data).pipe(
                Effect.mapError(failure)
            );
            return yield* error;
        }
        return yield* Schema.decodeUnknownEffect(schema)(data).pipe(Effect.mapError(failure));
    });
    const run = <A>(effect: Effect.Effect<A, BackendError>) =>
        Effect.runPromiseWith(captured)(
            Effect.acquireUseRelease(Effect.forkIn(effect, scope), Fiber.join, Fiber.interrupt)
        );
    const create: LiveOntology["attachments"]["create"] = async (input, options) => {
        const source = attachmentByteSource(input);
        const request = HttpClientRequest.post(url).pipe(
            HttpClientRequest.setUrlParam(
                uploadParameter,
                JSON.stringify({ size: source.size, type: source.type, name: source.name, ...options })
            ),
            HttpClientRequest.bodyStream(byteChunks(source), {
                contentType: "application/octet-stream",
                contentLength: source.size,
            })
        );
        const attachment = await run(execute(request, Attachment));
        return { attachment } as Awaited<ReturnType<LiveOntology["attachments"]["create"]>>;
    };
    const applyAction = Effect.fnUntraced(function* (invocation: ActionRequest) {
        const uploads = invocation.attachmentUploads ?? [];
        const files = uploads.map((upload) => ({
            attachment: upload.attachment,
            size: byteSource(upload.blob).size,
            type: byteSource(upload.blob).type,
            name: byteSource(upload.blob).name,
        }));
        const payload = yield* Effect.try({
            try: () => JSON.stringify(Schema.encodeSync(Payload)({ request: invocation, files })),
            catch: () => invalid("Invalid action upload metadata."),
        });
        if (new TextEncoder().encode(payload).length > maxMetadataBytes)
            return yield* invalid("Action upload metadata is too large.");
        const boundary = `party-${crypto.randomUUID()}`;
        const encode = (text: string) => new TextEncoder().encode(text);
        const content = Stream.concat(
            Stream.succeed(
                encode(
                    `--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json\r\n\r\n${payload}\r\n`
                )
            ),
            Stream.concat(
                Stream.fromIterable(
                    uploads.map((upload, index) => ({ upload, index })),
                    { chunkSize: 1 }
                ).pipe(
                    Stream.flatMap(({ upload, index }) =>
                        Stream.concat(
                            Stream.succeed(
                                encode(
                                    `--${boundary}\r\nContent-Disposition: form-data; name="file-${index}"; filename="attachment.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`
                                )
                            ),
                            Stream.concat(byteChunks(upload.blob), Stream.succeed(encode("\r\n")))
                        )
                    )
                ),
                Stream.succeed(encode(`--${boundary}--\r\n`))
            )
        );
        return yield* execute(
            HttpClientRequest.post(url).pipe(
                HttpClientRequest.setUrlParam(actionParameter, "1"),
                HttpClientRequest.bodyStream(content, {
                    contentType: `multipart/form-data; boundary=${boundary}`,
                })
            ),
            ActionReceiptSchema
        );
    });
    return { create, applyAction };
});
