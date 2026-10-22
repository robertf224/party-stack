import { BackendError, ActionReceiptSchema } from "@party-stack/ontology-backend";
import { ActionInvocationSchema, protocolValueCodec } from "@party-stack/ontology-backend/protocol";
import { ReplicaStatusSchema, makeReplicaMonitor } from "@party-stack/ontology-replica";
import { Effect, Queue, Schema, Stream, Fiber, Scope, Layer } from "effect";
import { Rpc, RpcGroup, RpcClient } from "effect/rpc";
import {
    Attachment,
    Target,
    AttachmentTransferRpcs,
    attachmentTransferHandlers,
    splitAttachmentChunk,
} from "./attachmentTransfers.js";
import type { LiveOntology } from "@party-stack/ontology";
import type { Headers } from "effect/http/Headers";
const Validation = Schema.Union([
    Schema.Struct({ certain: Schema.Literal(false) }),
    Schema.Struct({
        certain: Schema.Literal(true),
        value: Schema.Union([
            Schema.Struct({ kind: Schema.Literal("ok"), value: Schema.Void }),
            Schema.Struct({
                kind: Schema.Literal("err"),
                value: Schema.Array(
                    Schema.Struct({
                        message: Schema.String,
                        path: Schema.optional(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
                    })
                ),
            }),
        ]),
    }),
]);
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
    Rpc.make("QueryFunction", {
        payload: protocolValueCodec(Schema.Struct({ name: Schema.NonEmptyString, parameters: Parameters })),
        success: protocolValueCodec(Schema.Unknown),
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
                invocation: Schema.optional(ActionInvocationSchema),
                allowAmbiguous: Schema.optional(Schema.Boolean),
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
          readonly operation: "QueryFunction" | "ValidateAction";
          readonly name: string;
          readonly parameters: Record<string, unknown>;
          readonly knownParameters?: readonly string[];
      }
    | {
          readonly operation: "CreateAttachment";
          readonly id?: string;
          readonly target?: Schema.Schema.Type<typeof Target>;
          readonly type: string;
          readonly size: number;
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
          readonly invocation?: Schema.Schema.Type<typeof ActionInvocationSchema>;
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
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failure });
const missing = (name: string) =>
    new BackendError({
        operation: name,
        kind: "Unsupported",
        message: `Ontology operation ${name} is unavailable.`,
        retryable: false,
    });

export const ontologyOperationHandlers = <R>(options: {
    readonly ontology?: LiveOntology;
    readonly backend?: import("@party-stack/ontology-backend").OntologyBackendService;
    readonly ready?: Effect.Effect<void, BackendError, R>;
    readonly deleteLocalData?: Effect.Effect<void, BackendError, R>;
    readonly releaseOwner?: Effect.Effect<void, BackendError, R>;
    readonly authorize: (
        request: OntologyOperationRequest,
        headers: Headers
    ) => Effect.Effect<void, BackendError, R>;
}) => {
    const live = () =>
        (options.ready ?? Effect.void).pipe(
            Effect.andThen(() =>
                options.ontology ? Effect.succeed(options.ontology) : Effect.fail(missing("helpers"))
            )
        );
    return HelperRpcs.toLayer({
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
                );
            }),
        AttachmentMetadata: (request, context) =>
            Effect.gen(function* () {
                yield* options.authorize({ operation: "AttachmentMetadata", ...request }, context.headers);
                if (options.backend) {
                    yield* options.ready ?? Effect.void;
                    if (!options.backend.attachments?.metadata) return yield* missing("AttachmentMetadata");
                    return yield* options.backend.attachments.metadata(request.attachment);
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
                    if (!request.receipt || request.receipt.invocationId !== request.id)
                        return yield* missing("matching receipt");
                    yield* attempt(() => ontology.outbox.reconcile(request.id, request.receipt!));
                } else if (request.operation === "remove")
                    yield* attempt(() => ontology.outbox.remove(request.id));
                else
                    yield* attempt(() =>
                        ontology.outbox.retry(request.id, { allowAmbiguous: request.allowAmbiguous })
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
                create: (request, blob) =>
                    Effect.gen(function* () {
                        yield* options.ready ?? Effect.void;
                        if (options.backend) {
                            if (!options.backend.attachments?.stage)
                                return yield* missing("CreateAttachment");
                            return yield* options.backend.attachments.stage(
                                { id: request.id ?? crypto.randomUUID(), type: request.type },
                                blob
                            );
                        }
                        const ontology = yield* live();
                        const created = yield* attempt(() =>
                            request.eager
                                ? ontology.attachments.create(blob, {
                                      id: request.id,
                                      target: request.target,
                                      eager: true,
                                  })
                                : ontology.attachments.create(blob, {
                                      id: request.id,
                                      target: request.target,
                                  })
                        );
                        if (created.isMaterialized) yield* attempt(() => created.isMaterialized!);
                        return created.attachment;
                    }),
                read: (attachment, headers) =>
                    Effect.gen(function* () {
                        yield* options.authorize({ operation: "ReadAttachment", attachment }, headers);
                        yield* options.ready ?? Effect.void;
                        if (options.backend) {
                            if (!options.backend.attachments?.read) return yield* missing("ReadAttachment");
                            return yield* options.backend.attachments.read(attachment);
                        }
                        const ontology = yield* live();
                        return yield* attempt(() => ontology.attachments.blob(attachment));
                    }),
            })
        )
    );
};

type OperationsRpcClient = Effect.Success<
    ReturnType<typeof RpcClient.make<RpcGroup.Rpcs<typeof OntologyOperationRpcs>>>
>;
export interface OntologyOperationsClient {
    readonly queryFunction: (
        name: string,
        parameters: Record<string, unknown>
    ) => Effect.Effect<unknown, BackendError>;
    readonly validate: (
        name: string,
        parameters: Record<string, unknown>,
        knownParameters?: readonly string[]
    ) => ReturnType<LiveOntology["actions"][string]["validate"]>;
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
    const run = <A, E>(work: Effect.Effect<A, E>) =>
        Effect.runPromiseWith(context)(Effect.flatMap(Effect.forkIn(work, scope), Fiber.join));
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
        create: async (blob, opts) => {
            const attachment = await run(
                Effect.gen(function* () {
                    let result: Schema.Schema.Type<typeof Attachment> | undefined;
                    yield* Stream.runForEach(
                        client.CreateAttachment({
                            size: blob.size,
                            type: blob.type,
                            name: typeof File !== "undefined" && blob instanceof File ? blob.name : undefined,
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
                                    Stream.fromReadableStream({
                                        evaluate: () => blob.stream(),
                                        onError: failure,
                                    }),
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
        blob: (attachment) =>
            run(
                Effect.gen(function* () {
                    const parts: ArrayBuffer[] = [];
                    let metadata: { type: string; size: number; name?: string } | undefined;
                    let size = 0;
                    yield* Stream.runForEach(client.ReadAttachment(attachment), (event) =>
                        Effect.sync(() => {
                            if (event.kind === "metadata") metadata = event;
                            else {
                                parts.push(new Uint8Array(event.bytes).buffer);
                                size += event.bytes.length;
                            }
                        })
                    );
                    if (!metadata || size !== metadata.size)
                        return yield* failure(new Error("Incomplete attachment download."));
                    return metadata.name === undefined
                        ? new Blob(parts, { type: metadata.type })
                        : new File(parts, metadata.name, { type: metadata.type });
                })
            ),
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
        deleteLocalData: client.DeleteLocalData().pipe(Effect.mapError(failure)),
        releaseOwner: client.ReleaseOwner(undefined, { discard: true }).pipe(Effect.mapError(failure)),
        queryFunction: (name, parameters) =>
            client.QueryFunction({ name, parameters }).pipe(Effect.mapError(failure)),
        validate: (name, parameters, knownParameters) =>
            run(client.ValidateAction({ name, parameters, knownParameters })),
        attachments,
        outbox: {
            reconcile: (id, receipt) =>
                client.ControlOutbox({ operation: "reconcile", id, receipt }).pipe(Effect.mapError(failure)),
            remove: (id) => client.ControlOutbox({ operation: "remove", id }).pipe(Effect.mapError(failure)),
            retry: (id, settings) =>
                client
                    .ControlOutbox({ operation: "retry", id, allowAmbiguous: settings?.allowAmbiguous })
                    .pipe(Effect.mapError(failure)),
            edit: (id, invocation) =>
                client.ControlOutbox({ operation: "edit", id, invocation }).pipe(Effect.mapError(failure)),
        },
        traces,
        replicaMonitor,
    };
});
