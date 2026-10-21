import { BackendError, ActionReceiptSchema } from "@party-stack/ontology-backend";
import { ActionInvocationSchema, protocolValueCodec } from "@party-stack/ontology-backend/protocol";
import { ReplicaStatusSchema, makeReplicaMonitor } from "@party-stack/ontology-replica";
import { Effect, Queue, Schema, Stream, Fiber, Scope } from "effect";
import { Rpc, RpcGroup, RpcClient } from "effect/rpc";
import type { LiveOntology } from "@party-stack/ontology";
import type { Headers } from "effect/http/Headers";

const Attachment = Schema.Struct({
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
const Target = Schema.Union([
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
const Bytes = Schema.Struct({
    bytes: Schema.Uint8ArrayFromBase64,
    type: Schema.String,
    name: Schema.optional(Schema.String),
});
const Metadata = Schema.Struct({
    size: Schema.optional(Schema.Number),
    type: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
    dimensions: Schema.optional(Schema.Struct({ width: Schema.Number, height: Schema.Number })),
});

/** Explicit helper operations alongside replica transfer. These do not bypass row replication. */
export const OntologyOperationRpcs = RpcGroup.make(
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
    Rpc.make("CreateAttachment", {
        payload: Schema.Struct({
            ...Bytes.fields,
            id: Schema.optional(Schema.NonEmptyString),
            target: Schema.optional(Target),
            eager: Schema.optional(Schema.Boolean),
        }),
        success: Attachment,
        error: BackendError,
    }),
    Rpc.make("ReadAttachment", { payload: Attachment, success: Bytes, error: BackendError }),
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
    return OntologyOperationRpcs.toLayer({
        QueryFunction: (request, context) =>
            Effect.gen(function* () {
                yield* options.authorize({ operation: "QueryFunction", ...request }, context.headers);
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
        CreateAttachment: (request, context) =>
            Effect.gen(function* () {
                yield* options.authorize(
                    {
                        operation: "CreateAttachment",
                        id: request.id,
                        target: request.target,
                        type: request.type,
                        size: request.bytes.byteLength,
                    },
                    context.headers
                );
                const ontology = yield* live();
                const blob =
                    request.name === undefined
                        ? new Blob([new Uint8Array(request.bytes).buffer], { type: request.type })
                        : new File([new Uint8Array(request.bytes).buffer], request.name, {
                              type: request.type,
                          });
                const created = yield* attempt(() =>
                    request.eager
                        ? ontology.attachments.create(blob, {
                              id: request.id,
                              target: request.target,
                              eager: true,
                          })
                        : ontology.attachments.create(blob, { id: request.id, target: request.target })
                );
                // An eager request waits here; a Promise is never transported to another host.
                if (created.isMaterialized) yield* attempt(() => created.isMaterialized!);
                return created.attachment;
            }),
        ReadAttachment: (attachment, context) =>
            Effect.gen(function* () {
                yield* options.authorize({ operation: "ReadAttachment", attachment }, context.headers);
                const ontology = yield* live();
                const blob = yield* attempt(() => ontology.attachments.blob(attachment));
                return {
                    bytes: new Uint8Array(yield* attempt(() => blob.arrayBuffer())),
                    type: blob.type,
                    ...(typeof File !== "undefined" && blob instanceof File ? { name: blob.name } : {}),
                };
            }),
        AttachmentMetadata: (request, context) =>
            Effect.gen(function* () {
                yield* options.authorize({ operation: "AttachmentMetadata", ...request }, context.headers);
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
    });
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
                client.CreateAttachment({
                    bytes: new Uint8Array(await blob.arrayBuffer()),
                    type: blob.type,
                    name: typeof File !== "undefined" && blob instanceof File ? blob.name : undefined,
                    ...opts,
                })
            );
            return { attachment } as Awaited<ReturnType<LiveOntology["attachments"]["create"]>>;
        },
        blob: async (attachment) => {
            const result = await run(client.ReadAttachment(attachment));
            return result.name === undefined
                ? new Blob([new Uint8Array(result.bytes).buffer], { type: result.type })
                : new File([new Uint8Array(result.bytes).buffer], result.name, { type: result.type });
        },
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
