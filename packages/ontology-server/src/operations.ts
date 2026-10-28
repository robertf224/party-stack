import {
    BackendError,
    BackendSnapshotSchema,
    BackendChangePageSchema,
    ValidationReportSchema,
    ActionReceiptSchema,
    EncryptedValueSchema,
    encryptedPropertyCodec,
} from "@party-stack/ontology-backend";
import {
    ActionRequestSchema,
    BackendSubsetCodec,
    protocolValueCodec,
} from "@party-stack/ontology-backend/protocol";
import { ReplicaStatusSchema, makeReplicaMonitor } from "@party-stack/ontology-replica";
import { QueryDocumentSchema } from "@party-stack/ontology-spec/effect";
import {
    attachmentByteSource,
    byteChunks,
    collectByteBlob,
    type ByteSource,
} from "@party-stack/ontology-storage/blobs";
import { getTargetValueType } from "@party-stack/ontology/utils";
import { Effect, Exit, Option, Queue, Schema, Sink, Stream, Fiber, Scope, Layer } from "effect";
import { Rpc, RpcGroup, RpcClient } from "effect/rpc";
import {
    Attachment,
    Target,
    AttachmentTransferRpcs,
    attachmentTransferHandlers,
    splitAttachmentChunk,
} from "./attachmentTransfers.js";
import { projectValidationReport, type ErrorProjectionOptions } from "./errorProjection.js";
import type { AttachmentTransferPolicy } from "./attachmentTransfers.js";
import type { LiveOntology } from "@party-stack/ontology";
import type { Headers } from "effect/http/Headers";
const Validation = ValidationReportSchema;
const Trace = Schema.Struct({
    id: Schema.String,
    traceId: Schema.String,
    parentId: Schema.optional(Schema.String),
    name: Schema.String,
    startedAt: Schema.Number,
    durationMs: Schema.Number,
    outcome: Schema.Literals(["running", "success", "failure", "interrupted"]),
    error: Schema.optional(
        Schema.Struct({ kind: Schema.Literals(["Error", "Defect"]), message: Schema.String })
    ),
    events: Schema.optional(
        Schema.Array(
            Schema.Struct({
                name: Schema.String,
                at: Schema.Number,
                attributes: Schema.Record(
                    Schema.String,
                    Schema.Union([Schema.String, Schema.Number, Schema.Boolean])
                ),
            })
        )
    ),
    eventCount: Schema.optional(Schema.Number),
    attributes: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
});
const Parameters = Schema.Record(Schema.String, Schema.Unknown);
const Metadata = Schema.Struct({
    size: Schema.optional(Schema.Number),
    type: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
    dimensions: Schema.optional(Schema.Struct({ width: Schema.Number, height: Schema.Number })),
});

/** Explicit helper operations alongside replica transfer. These do not bypass row replication. */
const HelperRpcs = RpcGroup.make(
    Rpc.make("Query", {
        payload: protocolValueCodec(
            Schema.Struct({ document: QueryDocumentSchema, inputs: Schema.optional(Parameters) })
        ),
        success: protocolValueCodec(Parameters),
        error: BackendError,
    }),
    Rpc.make("LoadSubset", {
        payload: BackendSubsetCodec,
        success: protocolValueCodec(BackendSnapshotSchema),
        error: BackendError,
    }),
    Rpc.make("WatchChanges", { success: Schema.Literal("invalidate"), error: BackendError, stream: true }),
    Rpc.make("WatchSubset", {
        payload: BackendSubsetCodec,
        success: Schema.Literal("invalidate"),
        error: BackendError,
        stream: true,
    }),
    Rpc.make("PullChanges", {
        payload: Schema.Struct({
            cursor: Schema.optional(Schema.String),
            limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }))),
        }),
        success: protocolValueCodec(BackendChangePageSchema),
        error: BackendError,
    }),
    Rpc.make("ApplyAction", {
        payload: protocolValueCodec(ActionRequestSchema),
        success: ActionReceiptSchema,
        error: BackendError,
    }),
    Rpc.make("Decrypt", {
        payload: Schema.Struct({ value: EncryptedValueSchema, cache: Schema.optional(Schema.Boolean) }),
        success: protocolValueCodec(Schema.Unknown),
        error: BackendError,
    }),
    Rpc.make("QueryFunction", {
        payload: protocolValueCodec(Schema.Struct({ name: Schema.NonEmptyString, parameters: Parameters })),
        success: protocolValueCodec(Schema.Unknown),
        error: BackendError,
    }),
    Rpc.make("ResolveActionParameters", {
        payload: protocolValueCodec(Schema.Struct({ name: Schema.NonEmptyString, parameters: Parameters })),
        success: protocolValueCodec(Parameters),
        error: BackendError,
    }),
    Rpc.make("ValidateAction", {
        payload: protocolValueCodec(
            Schema.Struct({
                name: Schema.NonEmptyString,
                parameters: Parameters,
                knownParameters: Schema.optional(Schema.Array(Schema.String)),
            })
        ),
        success: protocolValueCodec(Validation),
        error: BackendError,
    }),
    Rpc.make("AttachmentMetadata", {
        payload: Schema.Struct({
            attachment: Attachment,
            select: Schema.optional(Schema.Array(Schema.Literals(["size", "type", "name", "dimensions"]))),
        }),
        success: Metadata,
        error: BackendError,
    }),
    Rpc.make("ControlOutbox", {
        payload: protocolValueCodec(
            Schema.Struct({
                operation: Schema.Literals(["remove", "retry", "edit", "reconcile"]),
                id: Schema.NonEmptyString,
                invocation: Schema.optional(ActionRequestSchema),
                allowUnknownOutcome: Schema.optional(Schema.Boolean),
                receipt: Schema.optional(ActionReceiptSchema),
            })
        ),
        error: BackendError,
    }),
    Rpc.make("ReplicaStatus", {
        success: protocolValueCodec(ReplicaStatusSchema),
        error: BackendError,
        stream: true,
    }),
    Rpc.make("Traces", { success: Schema.Array(Trace), error: BackendError, stream: true }),
    Rpc.make("ClearTraces", { error: BackendError }),
    Rpc.make("DeleteLocalData", { error: BackendError }),
    Rpc.make("ReleaseOwner", { error: BackendError })
);
export const OntologyOperationRpcs = HelperRpcs.merge(AttachmentTransferRpcs);
export type OntologyOperationRequest =
    | {
          readonly operation: "Query";
          readonly document: import("@party-stack/ontology-spec").QueryDocument;
          readonly inputs?: Record<string, unknown>;
      }
    | { readonly operation: "WatchChanges" }
    | { readonly operation: "PullChanges"; readonly cursor?: string; readonly limit?: number }
    | {
          readonly operation: "LoadSubset" | "WatchSubset";
          readonly subset: import("@party-stack/ontology-backend").BackendSubset;
      }
    | {
          readonly operation: "ApplyAction";
          readonly invocation: import("@party-stack/ontology-backend").ActionRequest;
      }
    | {
          readonly operation: "Decrypt";
          readonly value: import("@party-stack/ontology/values").Encrypted;
          readonly cache?: boolean;
      }
    | {
          readonly operation: "QueryFunction" | "ValidateAction" | "ResolveActionParameters";
          readonly name: string;
          readonly parameters: Record<string, unknown>;
          readonly knownParameters?: readonly string[];
      }
    | {
          readonly operation: "CreateAttachment";
          readonly id?: string;
          readonly target?: Schema.Schema.Type<typeof Target>;
          readonly type: string;
          readonly size?: number;
      }
    | {
          readonly operation: "ReadAttachment" | "AttachmentMetadata";
          readonly attachment: Schema.Schema.Type<typeof Attachment>;
          readonly select?: readonly string[];
      }
    | {
          readonly operation: "ControlOutbox";
          readonly id: string;
          readonly command: "remove" | "retry" | "edit" | "reconcile";
          readonly invocation?: Schema.Schema.Type<typeof ActionRequestSchema>;
      }
    | { readonly operation: "ReplicaStatus" | "Traces" | "ClearTraces" | "DeleteLocalData" | "ReleaseOwner" };

const failure = (cause: unknown) =>
    cause instanceof BackendError
        ? cause
        : new BackendError({
              operation: "ontology.operations",
              kind: "Unavailable",
              message: cause instanceof Error ? cause.message : "Ontology operation failed.",
              retryable: true,
              cause,
          });
const decryptFailure = (cause: unknown) =>
    new BackendError({
        operation: "decrypt",
        kind: cause instanceof BackendError ? cause.kind : "Unavailable",
        retryable: cause instanceof BackendError ? cause.retryable : true,
        message: "Decryption failed.",
    });
const attempt = <A>(run: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: failure });
const missing = (name: string) =>
    new BackendError({
        operation: name,
        kind: "NotImplemented",
        message: `Ontology operation ${name} is unavailable.`,
        retryable: false,
    });

export type OntologyOperationOptions<R = never> = ErrorProjectionOptions & {
    readonly query?: (
        document: import("@party-stack/ontology-spec").QueryDocument,
        inputs?: Record<string, unknown>
    ) => Effect.Effect<Record<string, unknown>, BackendError, R>;
    readonly attachmentTransfers?: AttachmentTransferPolicy<R>;
    readonly ontology?: LiveOntology;
    readonly backend?: import("@party-stack/ontology-backend").OntologyBackendService;
    readonly ready?: Effect.Effect<void, BackendError, R>;
    readonly deleteLocalData?: Effect.Effect<void, BackendError, R>;
    readonly releaseOwner?: Effect.Effect<void, BackendError, R>;
    readonly authorize: (
        request: OntologyOperationRequest,
        headers: Headers
    ) => Effect.Effect<void, BackendError, R>;
};

/** Shared storage/application operation; transports supply framing and authorization. */
export const ontologyAttachmentHandlers = <R>(options: OntologyOperationOptions<R>) => ({
    create: (
        request: import("./attachmentTransfers.js").AttachmentUpload,
        blob: import("@party-stack/ontology-storage/blobs").ByteInput
    ) =>
        Effect.gen(function* () {
            yield* options.ready ?? Effect.void;
            if (options.backend) {
                if (!options.backend.attachments?.stage) return yield* missing("CreateAttachment");
                const ir = options.ir ?? options.ontology?.ir;
                const type =
                    request.target && ir
                        ? yield* Effect.try({
                              try: () => getTargetValueType(ir, request.target!),
                              catch: () =>
                                  new BackendError({
                                      operation: "attachment.stage",
                                      kind: "InvalidRequest",
                                      message: "Invalid attachment target.",
                                      retryable: false,
                                  }),
                          })
                        : undefined;
                if (type && type.kind !== "attachment")
                    return yield* new BackendError({
                        operation: "attachment.stage",
                        kind: "InvalidRequest",
                        message: "Target is not an attachment.",
                        retryable: false,
                    });
                return yield* options.backend.attachments.stage(
                    { id: request.id ?? crypto.randomUUID(), type: request.type },
                    blob,
                    { target: type?.kind === "attachment" ? type.value : undefined }
                );
            }
            if (!options.ontology) return yield* missing("CreateAttachment");
            const created = yield* attempt(() =>
                options.ontology!.attachments.create(blob, {
                    id: request.id,
                    target: request.target,
                    eager: request.eager,
                })
            );
            if (created.isMaterialized) yield* attempt(() => created.isMaterialized!);
            return created.attachment;
        }),
    read: (attachment: import("./attachmentTransfers.js").AttachmentValue, headers: Headers) =>
        Effect.gen(function* () {
            yield* options.authorize({ operation: "ReadAttachment", attachment }, headers);
            yield* options.ready ?? Effect.void;
            if (options.backend) {
                if (!options.backend.attachments?.read) return yield* missing("ReadAttachment");
                return yield* options.backend.attachments.read(attachment);
            }
            if (!options.ontology) return yield* missing("ReadAttachment");
            return yield* attempt((signal) => options.ontology!.attachments.source(attachment, { signal }));
        }),
});

export const ontologyOperationHandlers = <R>(options: OntologyOperationOptions<R>) => {
    const live = () =>
        (options.ready ?? Effect.void).pipe(
            Effect.andThen(() =>
                options.ontology ? Effect.succeed(options.ontology) : Effect.fail(missing("helpers"))
            )
        );
    return HelperRpcs.toLayer({
        Query: (request, context) =>
            Effect.gen(function* () {
                yield* options.authorize({ operation: "Query", ...request }, context.headers);
                yield* options.ready ?? Effect.void;
                if (!options.query) return yield* missing("Query");
                return yield* options.query(request.document, request.inputs);
            }),
        LoadSubset: (subset, context) =>
            Effect.gen(function* () {
                yield* options.authorize({ operation: "LoadSubset", subset }, context.headers);
                yield* options.ready ?? Effect.void;
                if (!options.backend) return yield* missing("LoadSubset");
                return yield* options.backend.loadSubset(subset);
            }),
        WatchChanges: (_, context) =>
            Stream.unwrap(
                Effect.gen(function* () {
                    yield* options.authorize({ operation: "WatchChanges" }, context.headers);
                    yield* options.ready ?? Effect.void;
                    if (!options.backend?.changes?.watch) return yield* missing("WatchChanges");
                    return Stream.concat(
                        Stream.make("invalidate" as const),
                        options.backend.changes.watch.pipe(Stream.map(() => "invalidate" as const))
                    );
                })
            ),
        WatchSubset: (subset, context) =>
            Stream.unwrap(
                Effect.gen(function* () {
                    yield* options.authorize({ operation: "WatchSubset", subset }, context.headers);
                    yield* options.ready ?? Effect.void;
                    if (!options.backend) return yield* missing("WatchSubset");
                    const watched = options.backend.watchSubset?.(subset);
                    const interval = options.backend.pollIntervalMs?.(subset) ?? 5_000;
                    if (!watched && interval !== false && (!Number.isFinite(interval) || interval < 100))
                        return yield* new BackendError({
                            operation: "WatchSubset",
                            kind: "InvalidConfiguration",
                            retryable: false,
                            message: "Invalid subset poll interval.",
                        });
                    const changes = watched ?? (interval === false ? Stream.never : Stream.tick(interval));
                    // A new subscription is also a repair boundary for missed invalidations.
                    return Stream.concat(
                        Stream.make("invalidate" as const),
                        changes.pipe(Stream.map(() => "invalidate" as const))
                    );
                })
            ),
        PullChanges: (request, context) =>
            Effect.gen(function* () {
                yield* options.authorize({ operation: "PullChanges", ...request }, context.headers);
                yield* options.ready ?? Effect.void;
                if (!options.backend?.changes) return yield* missing("PullChanges");
                return yield* options.backend.changes.pull(request);
            }),
        ApplyAction: (invocation, context) =>
            Effect.gen(function* () {
                yield* options.authorize({ operation: "ApplyAction", invocation }, context.headers);
                yield* options.ready ?? Effect.void;
                if (!options.backend) return yield* missing("ApplyAction");
                return yield* options.backend.applyAction(invocation);
            }),
        Decrypt: (request, context) =>
            Effect.gen(function* () {
                yield* options.authorize({ operation: "Decrypt", ...request }, context.headers);
                yield* options.ready ?? Effect.void;
                if (options.backend) {
                    if (!options.backend.encrypted) return yield* missing("Decrypt");
                    const result = yield* options.backend.encrypted.decrypt(request.value);
                    if (result.ciphertext !== undefined && result.ciphertext !== request.value.ciphertext)
                        return yield* new BackendError({
                            operation: "decrypt",
                            kind: "Conflict",
                            message: "The encrypted value changed.",
                            retryable: false,
                        });
                    return result.value;
                }
                const ontology = yield* live();
                const value = yield* Effect.tryPromise({
                    try: (signal) => ontology.decrypt(request.value, { cache: request.cache, signal }),
                    catch: decryptFailure,
                });
                return yield* Effect.try({
                    try: () => encryptedPropertyCodec(ontology.ir, request.value).encode(value),
                    catch: () =>
                        new BackendError({
                            operation: "decrypt",
                            kind: "InvalidResponse",
                            message: "Invalid decrypted value.",
                            retryable: false,
                        }),
                });
            }).pipe(Effect.mapError(decryptFailure)),
        ResolveActionParameters: (request, context) =>
            Effect.gen(function* () {
                yield* options.authorize(
                    { operation: "ResolveActionParameters", ...request },
                    context.headers
                );
                yield* options.ready ?? Effect.void;
                if (options.backend) {
                    if (!options.backend.resolveActionParameters)
                        return yield* missing("ResolveActionParameters");
                    return yield* options.backend.resolveActionParameters(request.name, request.parameters);
                }
                const ontology = yield* live();
                const action = Object.hasOwn(ontology.actions, request.name)
                    ? ontology.actions[request.name]
                    : undefined;
                if (!action) return yield* missing("ResolveActionParameters");
                return yield* attempt(() => action.resolveParameters(request.parameters));
            }),
        QueryFunction: (request, context) =>
            Effect.gen(function* () {
                yield* options.authorize({ operation: "QueryFunction", ...request }, context.headers);
                if (options.backend) {
                    yield* options.ready ?? Effect.void;
                    if (!options.backend.queryFunction) return yield* missing(request.name);
                    return yield* options.backend.queryFunction(request.name, request.parameters);
                }
                const ontology = yield* live();
                const query = Object.hasOwn(ontology.queryFunctions, request.name)
                    ? ontology.queryFunctions[request.name]
                    : undefined;
                if (!query) return yield* missing(request.name);
                return yield* attempt(() => query(request.parameters));
            }),
        ValidateAction: (request, context) =>
            Effect.gen(function* () {
                yield* options.authorize({ operation: "ValidateAction", ...request }, context.headers);
                if (options.backend?.validateAction)
                    return yield* options.backend
                        .validateAction(request.name, request.parameters, {
                            knownParameters: request.knownParameters,
                        })
                        .pipe(Effect.map((report) => projectValidationReport(report, options, request.name)));
                const ontology = yield* live();
                const action = Object.hasOwn(ontology.actions, request.name)
                    ? ontology.actions[request.name]
                    : undefined;
                if (!action) return yield* missing(request.name);
                return yield* attempt(() =>
                    request.knownParameters
                        ? action.validateDraft(request.parameters, {
                              knownParameters: request.knownParameters,
                          })
                        : action.validate(request.parameters)
                ).pipe(Effect.map((report) => projectValidationReport(report, options, request.name)));
            }),
        AttachmentMetadata: (request, context) =>
            Effect.gen(function* () {
                yield* options.authorize({ operation: "AttachmentMetadata", ...request }, context.headers);
                if (options.backend) {
                    yield* options.ready ?? Effect.void;
                    if (!options.backend.attachments?.metadata) return yield* missing("AttachmentMetadata");
                    return yield* options.backend.attachments.metadata(request.attachment, {
                        select: request.select,
                    });
                }
                const ontology = yield* live();
                return yield* attempt(() =>
                    ontology.attachments.metadata(request.attachment, {
                        select: (request.select as readonly ("size" | "type" | "name")[]) ?? [
                            "size",
                            "type",
                            "name",
                        ],
                    })
                );
            }),
        ControlOutbox: (request, context) =>
            Effect.gen(function* () {
                yield* options.authorize(
                    {
                        operation: "ControlOutbox",
                        id: request.id,
                        command: request.operation,
                        invocation: request.invocation,
                    },
                    context.headers
                );
                const ontology = yield* live();
                if (request.operation === "edit") {
                    const invocation = request.invocation;
                    if (!invocation || invocation.id !== request.id) return yield* missing("edit invocation");
                    yield* attempt(() =>
                        ontology.outbox.edit(request.id, (draft) => {
                            draft.actionTypeName = invocation.name;
                            draft.parameters = invocation.parameters;
                        })
                    );
                } else if (request.operation === "reconcile") {
                    if (!request.receipt || request.receipt.operationId !== request.id)
                        return yield* missing("matching receipt");
                    yield* attempt(() => ontology.outbox.reconcile(request.id, request.receipt!));
                } else if (request.operation === "remove")
                    yield* attempt(() =>
                        ontology.outbox.remove(request.id, {
                            allowUnknownOutcome: request.allowUnknownOutcome,
                        })
                    );
                else
                    yield* attempt(() =>
                        ontology.outbox.retry(request.id, {
                            allowUnknownOutcome: request.allowUnknownOutcome,
                        })
                    );
            }),
        ReplicaStatus: (_, context) =>
            Stream.unwrap(
                Effect.gen(function* () {
                    yield* Effect.annotateCurrentSpan("activity", "subscription");
                    yield* options.authorize({ operation: "ReplicaStatus" }, context.headers);
                    const ontology = yield* live();
                    if (!ontology.storage) return yield* missing("ReplicaStatus");
                    return ontology.storage.statuses;
                })
            ),
        Traces: (_, context) =>
            Stream.unwrap(
                Effect.gen(function* () {
                    yield* Effect.annotateCurrentSpan("activity", "subscription");
                    yield* options.authorize({ operation: "Traces" }, context.headers);
                    const ontology = yield* live();
                    const traces = ontology.traces;
                    if (!traces) return Stream.succeed([]);
                    return Stream.callback<readonly Schema.Schema.Type<typeof Trace>[]>(
                        (queue) =>
                            Effect.acquireRelease(
                                Effect.sync(() => {
                                    const send = () => Queue.offerUnsafe(queue, traces.getSnapshot());
                                    const unsubscribe = traces.subscribe(send);
                                    send();
                                    return unsubscribe;
                                }),
                                (unsubscribe) => Effect.sync(unsubscribe)
                            ),
                        { bufferSize: 1, strategy: "sliding" }
                    );
                })
            ),
        DeleteLocalData: (_, context) =>
            options
                .authorize({ operation: "DeleteLocalData" }, context.headers)
                .pipe(Effect.andThen(options.deleteLocalData ?? Effect.fail(missing("DeleteLocalData")))),
        ReleaseOwner: (_, context) =>
            options
                .authorize({ operation: "ReleaseOwner" }, context.headers)
                .pipe(Effect.andThen(options.releaseOwner ?? Effect.fail(missing("ReleaseOwner")))),
        ClearTraces: (_, context) =>
            Effect.gen(function* () {
                yield* options.authorize({ operation: "ClearTraces" }, context.headers);
                const ontology = yield* live();
                ontology.traces?.clear();
            }),
    }).pipe(
        Layer.merge(
            attachmentTransferHandlers({
                ...options.attachmentTransfers,
                authorizeUpload: (request, headers) =>
                    options.authorize(
                        {
                            operation: "CreateAttachment",
                            id: request.id,
                            target: request.target,
                            type: request.type,
                            size: request.size,
                        },
                        headers
                    ),
                ...ontologyAttachmentHandlers(options),
            })
        )
    );
};

type OperationsRpcClient = Effect.Success<
    ReturnType<typeof RpcClient.make<RpcGroup.Rpcs<typeof OntologyOperationRpcs>>>
>;
export interface OntologyOperationsClient {
    readonly query: (
        document: import("@party-stack/ontology-spec").QueryDocument,
        inputs?: Record<string, unknown>
    ) => Effect.Effect<Record<string, unknown>, BackendError>;
    /** Portable plaintext; the view decodes it against its ontology definition. Cache policy runs at the owner. */
    readonly decrypt: (
        value: import("@party-stack/ontology/values").Encrypted,
        options?: { cache?: boolean }
    ) => Effect.Effect<unknown, BackendError>;
    readonly queryFunction: (
        name: string,
        parameters: Record<string, unknown>
    ) => Effect.Effect<unknown, BackendError>;
    readonly resolveActionParameters: (
        name: string,
        parameters: Record<string, unknown>
    ) => Effect.Effect<Record<string, unknown>, BackendError>;
    readonly validate: (
        name: string,
        parameters: Record<string, unknown>,
        knownParameters?: readonly string[]
    ) => Effect.Effect<import("@party-stack/ontology-backend").ValidationReport, BackendError>;
    readonly attachments: LiveOntology["attachments"];
    readonly outbox: Pick<
        import("@party-stack/ontology-replica").ReplicaService,
        "remove" | "retry" | "edit" | "reconcile"
    >;
    readonly traces: import("@party-stack/runtime").RuntimeTraceStore;
    readonly replicaMonitor: import("@party-stack/ontology-replica").ReplicaMonitor;
    readonly deleteLocalData: Effect.Effect<void, BackendError>;
    readonly releaseOwner: Effect.Effect<void, BackendError>;
}

export const makeOntologyOperationsClient = Effect.fnUntraced(function* (
    client: OperationsRpcClient
): Effect.fn.Return<OntologyOperationsClient, never, Scope.Scope> {
    const replicaMonitor = yield* makeReplicaMonitor(client.ReplicaStatus().pipe(Stream.mapError(failure)));
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<never>();
    const run = <A, E>(work: Effect.Effect<A, E>, signal?: AbortSignal) =>
        Effect.runPromiseWith(context)(
            Effect.acquireUseRelease(Effect.forkIn(work, scope), Fiber.join, Fiber.interrupt),
            { signal }
        );
    const listeners = new Set<() => void>();
    let spans: readonly import("@party-stack/runtime").RuntimeTrace[] = [];
    let watcher: Fiber.Fiber<void> | undefined;
    const notify = () => {
        for (const listener of listeners) {
            try {
                listener();
            } catch {
                /* Observers do not own the transport. */
            }
        }
    };
    const watch = Stream.runForEach(client.Traces(), (snapshot) =>
        Effect.sync(() => {
            spans = snapshot;
            notify();
        })
    ).pipe(Effect.catch(() => Effect.void));
    const traces = {
        getSnapshot: () => spans,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            if (!watcher) watcher = Effect.runSyncWith(context)(Effect.forkIn(watch, scope));
            return () => {
                listeners.delete(listener);
                if (!listeners.size && watcher) {
                    Effect.runFork(Fiber.interrupt(watcher));
                    watcher = undefined;
                }
            };
        },
        clear: () => {
            void run(client.ClearTraces()).catch(() => undefined);
        },
    };
    yield* Effect.addFinalizer(() => (watcher ? Fiber.interrupt(watcher).pipe(Effect.asVoid) : Effect.void));
    const attachments: LiveOntology["attachments"] = {
        create: async (input, opts) => {
            const blob = attachmentByteSource(input);
            const attachment = await run(
                Effect.gen(function* () {
                    let result: Schema.Schema.Type<typeof Attachment> | undefined;
                    yield* Stream.runForEach(
                        client.CreateAttachment({
                            size: blob.size,
                            type: blob.type,
                            name: blob.name,
                            ...opts,
                        }),
                        (event) =>
                            Effect.gen(function* () {
                                if (event.kind === "complete") {
                                    result = event.attachment;
                                    return;
                                }
                                let sequence = 0;
                                yield* Stream.runForEach(
                                    byteChunks(blob).pipe(Stream.mapError(failure)),
                                    (chunk) =>
                                        Effect.forEach(
                                            splitAttachmentChunk(chunk),
                                            (bytes) =>
                                                client.WriteAttachmentChunk({
                                                    uploadId: event.uploadId,
                                                    sequence: sequence++,
                                                    bytes,
                                                    end: false,
                                                }),
                                            { discard: true }
                                        )
                                );
                                yield* client.WriteAttachmentChunk({
                                    uploadId: event.uploadId,
                                    sequence,
                                    bytes: new Uint8Array(0),
                                    end: true,
                                });
                            })
                    );
                    if (!result) return yield* missing("completed attachment transfer");
                    return result;
                })
            );
            return { attachment } as Awaited<ReturnType<LiveOntology["attachments"]["create"]>>;
        },
        source: async (attachment, options): Promise<ByteSource> => {
            const readScope = await run(Scope.fork(scope), options?.signal);
            try {
                // Read the stream's own header. A separate metadata request can
                // otherwise download the whole body to derive unknown size/name.
                const [header, tail] = await run(
                    Scope.provide(
                        Stream.peel(
                            client.ReadAttachment(attachment),
                            Sink.head<Stream.Success<ReturnType<OperationsRpcClient["ReadAttachment"]>>>()
                        ),
                        readScope
                    ),
                    options?.signal
                );
                if (Option.isNone(header) || header.value.kind !== "metadata")
                    throw failure(new Error("Missing attachment metadata."));
                const { kind: _kind, ...metadata } = header.value;
                let consumed = false;
                return {
                    ...metadata,
                    stream: Stream.suspend(() => {
                        if (consumed)
                            return Stream.unwrap(
                                Effect.tryPromise({
                                    try: () => attachments.source(attachment, options),
                                    catch: failure,
                                }).pipe(Effect.map((source) => source.stream))
                            );
                        consumed = true;
                        let received = 0;
                        return Stream.concat(
                            tail.pipe(
                                Stream.mapEffect((event) =>
                                    Effect.gen(function* () {
                                        if (event.kind !== "bytes")
                                            return yield* failure(
                                                new Error("Duplicate attachment metadata.")
                                            );
                                        received += event.bytes.length;
                                        if (metadata.size !== undefined && received > metadata.size)
                                            return yield* failure(
                                                new Error("Attachment exceeds its declared size.")
                                            );
                                        return event.bytes;
                                    })
                                )
                            ),
                            Stream.fromEffect(
                                Effect.gen(function* () {
                                    if (metadata.size !== undefined && received !== metadata.size)
                                        return yield* failure(new Error("Incomplete attachment download."));
                                })
                            ).pipe(Stream.drain)
                        ).pipe(Stream.ensuring(Scope.close(readScope, Exit.void)));
                    }).pipe(Stream.provideContext(context)),
                };
            } catch (cause) {
                await Effect.runPromise(Scope.close(readScope, Exit.void));
                throw failure(cause);
            }
        },
        blob: async (attachment) => run(collectByteBlob(await attachments.source(attachment))),
        metadata: async (
            attachment: import("@party-stack/ontology/values").attachment,
            opts?: { select: readonly ("size" | "type" | "name" | "dimensions")[] }
        ) =>
            ({
                ...attachment,
                ...(await run(client.AttachmentMetadata({ attachment, select: opts?.select }))),
            }) as Awaited<ReturnType<LiveOntology["attachments"]["metadata"]>>,
    };
    return {
        query: (document, inputs) => client.Query({ document, inputs }).pipe(Effect.mapError(failure)),
        decrypt: (value, settings) =>
            client.Decrypt({ value, cache: settings?.cache }).pipe(Effect.mapError(decryptFailure)),
        deleteLocalData: client.DeleteLocalData().pipe(Effect.mapError(failure)),
        releaseOwner: client.ReleaseOwner(undefined, { discard: true }).pipe(Effect.mapError(failure)),
        queryFunction: (name, parameters) =>
            client.QueryFunction({ name, parameters }).pipe(Effect.mapError(failure)),
        resolveActionParameters: (name, parameters) =>
            client.ResolveActionParameters({ name, parameters }).pipe(Effect.mapError(failure)),
        validate: (name, parameters, knownParameters) =>
            client.ValidateAction({ name, parameters, knownParameters }).pipe(Effect.mapError(failure)),
        attachments,
        outbox: {
            reconcile: (id, receipt) =>
                client.ControlOutbox({ operation: "reconcile", id, receipt }).pipe(Effect.mapError(failure)),
            remove: (id, settings) =>
                client
                    .ControlOutbox({
                        operation: "remove",
                        id,
                        allowUnknownOutcome: settings?.allowUnknownOutcome,
                    })
                    .pipe(Effect.mapError(failure)),
            retry: (id, settings) =>
                client
                    .ControlOutbox({
                        operation: "retry",
                        id,
                        allowUnknownOutcome: settings?.allowUnknownOutcome,
                    })
                    .pipe(Effect.mapError(failure)),
            edit: (id, invocation) =>
                client.ControlOutbox({ operation: "edit", id, invocation }).pipe(Effect.mapError(failure)),
        },
        traces,
        replicaMonitor,
    };
});
