import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { executeAction, resolveReadActionParameters } from "@party-stack/ontology-backend/actions";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { eq, field } from "@party-stack/ontology-storage";
import { Effect, Stream, Scope } from "effect";
import { makeBlobManagerFromStorage } from "./attachments/manager.js";
import { prepareActionParameters } from "./attachments/prepare.js";
import { makeReplicaAttachments } from "./attachments/service.js";
import { makeReplicaDecryption } from "./decrypt.js";
import { makeReplicaKernel } from "./engine.js";
import { kernel } from "./internal.js";
import { makeQueryPin } from "./pins.js";
import type { ReplicaAttachments } from "./attachments/service.js";
import type { DemandPolicy } from "./demandCache.js";
import type { ReplicaService as KernelService } from "./engine.js";
import type { PinOptions, PinStatus } from "./pins.js";
import type { ObjectCacheGcPolicy, ObjectCacheSweepOptions } from "./policies.js";
import type { ReplicaStatus } from "./status.js";
import type { ReplicaRowsBatch } from "./visible.js";
import type { ConnectionMonitor } from "@party-stack/connect";
import type {
    ActionReceipt,
    ValidationReport,
    ActionRequest,
    OntologyBackendService,
    BackendAttachments,
} from "@party-stack/ontology-backend";
import type { ActionMutatorRegistry } from "@party-stack/ontology-backend/actions";
import type { ClientPolicy } from "@party-stack/ontology-backend/clients";
import type { OntologySource, PendingAction, ClientSubmission } from "@party-stack/ontology-backend/protocol";
import type { QueryDocument } from "@party-stack/ontology-spec";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { ObjectSubset } from "@party-stack/ontology-spec/query";
import type { Encrypted, attachment } from "@party-stack/ontology-spec/values";
import type { Key, Row, Query } from "@party-stack/ontology-storage";
import type { BlobStorageService } from "@party-stack/ontology-storage/blobs";
import type { EncryptionKeyringService } from "@party-stack/ontology-storage/encrypted";
import type { TablesService } from "@party-stack/ontology-storage/tables";
import type { NetworkConnectivity, ResourceCapacity } from "@party-stack/runtime";

export interface ReplicaConfiguration {
    readonly ir: OntologyIR;
    readonly context?: Record<string, unknown>;
    readonly mutators?: ActionMutatorRegistry;
    /** False acquires one-shot demand without background workers or new application outbox submissions. */
    readonly live?: boolean;
    readonly demand?: DemandPolicy;
    readonly outbox?: {
        readonly retryPolicy?: { readonly maxRetries?: number; readonly retryDelayMs?: number };
        readonly failureStrategy?: "pause" | "discard-all";
        /** Completed results only. Pending intent never expires. Default seven days. */
        readonly resultRetentionMs?: number;
    };
    /** Only used when this replica serves speculative children. */
    readonly clientSessions?: ClientPolicy;
    readonly cache?: {
        readonly objects?: ObjectCacheGcPolicy | false;
        readonly attachments?:
            | {
                  readonly minUnusedAgeMs?: number;
                  readonly sweepIntervalMs?: number;
                  readonly maxBytes?: number;
                  readonly targetBytes?: number;
              }
            | false;
    };
}
export type ReplicaOutboxPolicy = NonNullable<ReplicaConfiguration["outbox"]>;
export type ReplicaOptions = ReplicaConfiguration & {
    readonly namespace: string;
    readonly tables: TablesService;
    readonly attachments?: Pick<BackendAttachments, "read"> & Partial<Omit<BackendAttachments, "read">>;
    readonly blobs?: BlobStorageService;
    readonly encrypted?: OntologyBackendService["encrypted"];
    readonly encryptionKeyring?: EncryptionKeyringService;
    readonly network?: NetworkConnectivity;
    readonly capacity?: ResourceCapacity;
    readonly authentication?: Pick<ConnectionMonitor, "state" | "changes">;
} & (
        | { readonly backend: OntologyBackendService; readonly source?: never }
        | { readonly source: OntologySource; readonly backend?: OntologyBackendService }
    );
export interface ReplicaReads {
    readonly get: (
        objectType: string,
        key: Key
    ) => Effect.Effect<Record<string, unknown> | undefined, BackendError>;
    /** Read installed rows only; use demand.acquire to acquire upstream interest. */
    readonly readSubset: (
        subset: ObjectSubset
    ) => Effect.Effect<readonly Row<Record<string, unknown>>[], BackendError>;
}
export interface ReplicaActionStatus {
    readonly pending?: PendingAction;
    readonly receipt?: ActionReceipt;
    readonly error?: BackendError;
    readonly parentAcceptance?: { readonly sourceId: string };
}
export interface ReplicaOutbox {
    readonly enqueue: (
        request: ActionRequest,
        options?: { readonly optimistic?: boolean }
    ) => Effect.Effect<PendingAction, BackendError>;
    readonly entries: Effect.Effect<
        readonly (PendingAction & { readonly forwarding: boolean })[],
        BackendError
    >;
    readonly observe: (
        ids?: readonly string[]
    ) => Stream.Stream<readonly (PendingAction & { readonly forwarding: boolean })[], BackendError>;
    readonly get: (id: string) => Effect.Effect<ReplicaActionStatus, BackendError>;
    readonly wait: (
        id: string,
        options?: { readonly until?: "accepted" | "confirmed" }
    ) => Effect.Effect<ActionReceipt | undefined, BackendError>;
    readonly edit: (id: string, request: ActionRequest) => Effect.Effect<void, BackendError>;
    readonly retry: (
        id: string,
        options?: { readonly allowUnknownOutcome?: boolean }
    ) => Effect.Effect<void, BackendError>;
    readonly remove: (
        id: string,
        options?: { readonly allowUnknownOutcome?: boolean }
    ) => Effect.Effect<void, BackendError>;
}
export interface ReplicaService extends ReplicaReads {
    readonly ir: OntologyIR;
    readonly context: Record<string, unknown>;
    readonly sourceId: string;
    readonly upstreamKind: "committed" | "speculative";
    readonly network: NetworkConnectivity;
    readonly authentication?: Pick<ConnectionMonitor, "state" | "changes">;
    readonly decrypt: (
        value: Encrypted,
        options?: { readonly cache?: boolean }
    ) => Effect.Effect<{ readonly value: unknown; readonly ciphertext?: string }, BackendError>;
    readonly attachments: ReplicaAttachments;
    readonly actions: {
        readonly resolveParameters: (
            name: string,
            parameters: Record<string, unknown>
        ) => Effect.Effect<Record<string, unknown>, BackendError>;
        readonly validate: (
            name: string,
            parameters: Record<string, unknown>,
            options?: { readonly knownParameters?: readonly string[] }
        ) => Effect.Effect<ValidationReport, BackendError>;
        /** Defaults to direct admission; both modes await authoritative confirmation and local reconciliation. */
        readonly apply: (
            request: ActionRequest,
            options?: { readonly mode?: "direct" | "outbox"; readonly optimistic?: boolean }
        ) => Effect.Effect<ActionReceipt, BackendError>;
    };
    readonly confirmed: ReplicaReads;
    readonly observeSubset: (subset: ObjectSubset) => Stream.Stream<ReplicaRowsBatch, BackendError>;
    readonly demand: {
        readonly setPin: (query: QueryDocument, options?: PinOptions) => Effect.Effect<void, BackendError>;
        readonly clearPin: Effect.Effect<void, BackendError>;
        readonly pinStatus: Effect.Effect<PinStatus | undefined, BackendError>;
        readonly acquire: (
            subset: ObjectSubset,
            options?: { readonly localOnly?: boolean }
        ) => Effect.Effect<void, BackendError, Scope.Scope>;
    };
    readonly outbox: ReplicaOutbox;
    readonly status: {
        readonly get: Effect.Effect<ReplicaStatus, BackendError>;
        readonly changes: Stream.Stream<ReplicaStatus, BackendError>;
    };
    /** Explicit bounded checkpoint, including existing pending actions in one-shot mode. */
    readonly syncOnce: Effect.Effect<void, BackendError>;
    readonly collectGarbage: (options?: ObjectCacheSweepOptions) => Effect.Effect<number, BackendError>;
}
export const makeReplica = Effect.fn("Replica.open")(function* (
    options: ReplicaOptions
): Effect.fn.Return<ReplicaService, BackendError, Scope.Scope> {
    if (
        options.cache?.attachments &&
        options.cache.attachments.sweepIntervalMs !== undefined &&
        (!Number.isFinite(options.cache.attachments.sweepIntervalMs) ||
            options.cache.attachments.sweepIntervalMs < 10)
    )
        return yield* new BackendError({
            operation: "replica.configure",
            kind: "InvalidConfiguration",
            retryable: false,
            message: "Attachment cache sweep interval must be at least 10 milliseconds.",
        });
    for (const policy of [options.cache?.objects, options.cache?.attachments]) {
        if (!policy) continue;
        if (
            (policy.maxBytes !== undefined && (!Number.isFinite(policy.maxBytes) || policy.maxBytes < 0)) ||
            (policy.targetBytes !== undefined &&
                (!Number.isFinite(policy.targetBytes) ||
                    policy.targetBytes < 0 ||
                    policy.maxBytes === undefined ||
                    policy.targetBytes > policy.maxBytes))
        )
            return yield* new BackendError({
                operation: "replica.configure",
                kind: "InvalidConfiguration",
                retryable: false,
                message: "Cache targets must be nonnegative and no larger than a finite maximum.",
            });
    }
    const resultAge = options.outbox?.resultRetentionMs;
    if (resultAge !== undefined && (Number.isNaN(resultAge) || resultAge < 0))
        return yield* new BackendError({
            operation: "replica.configure",
            kind: "InvalidConfiguration",
            retryable: false,
            message: "Completed action retention must be nonnegative or Infinity.",
        });
    const poll = options.demand?.refresh?.pollIntervalMs;
    if (poll !== undefined && poll !== false && (!Number.isFinite(poll) || poll < 100))
        return yield* new BackendError({
            operation: "replica.configure",
            kind: "InvalidConfiguration",
            retryable: false,
            message: "Demand polling must be false or at least 100 milliseconds.",
        });
    const remoteAttachments = options.attachments ?? options.backend?.attachments;
    const manager = options.blobs
        ? yield* makeBlobManagerFromStorage({
              storage: options.blobs,
              gcTime:
                  options.cache?.attachments === false
                      ? Infinity
                      : (options.cache?.attachments?.minUnusedAgeMs ?? 5 * 60_000),
              budget: options.cache?.attachments === false ? undefined : options.cache?.attachments,
              sweepIntervalMs:
                  options.cache?.attachments === false
                      ? undefined
                      : options.cache?.attachments?.sweepIntervalMs,
              remote: {
                  read: (id, settings) =>
                      remoteAttachments
                          ? remoteAttachments.read({
                                ...(settings?.meta?.attachment as attachment | undefined),
                                id,
                            })
                          : Effect.fail(
                                new BackendError({
                                    operation: "attachment.read",
                                    kind: "NotImplemented",
                                    retryable: false,
                                    message: "Attachment reads are unavailable.",
                                })
                            ),
                  metadata: remoteAttachments?.metadata
                      ? (id, settings) =>
                            remoteAttachments.metadata!(
                                {
                                    ...(settings?.meta?.attachment as attachment | undefined),
                                    id,
                                },
                                { select: settings?.select }
                            )
                      : undefined,
              },
          })
        : undefined;
    const attachments = yield* makeReplicaAttachments({
        ir: options.ir,
        manager,
        stage: remoteAttachments?.stage,
    });
    const prepare = (request: ActionRequest) =>
        prepareActionParameters({
            ir: options.ir,
            actionTypeName: request.name,
            parameters: request.parameters,
            blobManager: manager,
        });
    const transfer =
        <A>(submit: (request: ClientSubmission) => Effect.Effect<A, BackendError>) =>
        (request: ClientSubmission) =>
            Effect.gen(function* () {
                const prepared = yield* prepare(request.invocation);
                const submission = {
                    ...request,
                    stagedAttachments: prepared.attachmentUploads.map((upload) => upload.attachment.id),
                };
                const result = yield* Effect.result(submit(submission));
                if (result._tag === "Success") return result.success;
                if (
                    result.failure.kind !== "NotFound" ||
                    result.failure.operation !== "replica.submit.attachments"
                )
                    return yield* result.failure;
                if (!remoteAttachments?.stage) return yield* result.failure;
                for (const upload of prepared.attachmentUploads) {
                    const staged = yield* remoteAttachments.stage(upload.attachment, upload.blob, {
                        target: upload.target,
                    });
                    if (staged.id !== upload.attachment.id)
                        return yield* new BackendError({
                            operation: "attachment.handoff",
                            kind: "Conflict",
                            retryable: false,
                            actionOutcome: "not-committed",
                            message: "A speculative parent must preserve staged attachment IDs.",
                        });
                }
                return yield* submit(submission);
            });
    const engine = yield* makeReplicaKernel({
        ...options,
        ...(options.source
            ? {
                  source: {
                      ...options.source,
                      submit: transfer(options.source.submit),
                      accept: options.source.accept ? transfer(options.source.accept) : undefined,
                  },
                  backend: undefined,
              }
            : {
                  source: undefined,
                  backend: {
                      ...options.backend!,
                      applyAction: (request: ActionRequest) =>
                          Effect.gen(function* () {
                              const prepared = yield* prepare(request);
                              return yield* options.backend!.applyAction({
                                  ...request,
                                  parameters: prepared.parameters,
                                  attachmentUploads: prepared.attachmentUploads,
                              });
                          }),
                  },
              }),
        startSync: options.live !== false,
        objectCacheGc: options.cache?.objects,
        connectivity: options.network,
        connection: options.authentication,
        clients: options.clientSessions,
        resultRetentionMs: options.outbox?.resultRetentionMs,
        outbox: { ...options.outbox?.retryPolicy, failureStrategy: options.outbox?.failureStrategy },
        execute: (tx, request, settings) =>
            executeAction({
                ir: options.ir,
                tx,
                request,
                context: options.context,
                mutators: options.mutators,
                resolveOnly: settings?.optimistic === false,
            }),
    });
    const decryption = makeReplicaDecryption({
        ir: options.ir,
        namespace: options.namespace,
        keyring: options.encryptionKeyring,
        cache: engine.encryptedCache,
        backend: {
            sourceId: options.source?.sourceId ?? options.backend!.sourceId,
            encrypted: options.encrypted ?? options.backend?.encrypted,
        },
    });
    const pin = yield* makeQueryPin({
        ...options,
        engine,
        live: options.live !== false,
        attachments: remoteAttachments,
    });
    const status = Effect.gen(function* () {
        const current = yield* engine.status;
        const pinned = yield* pin.pinStatus;
        const memory = options.capacity && (yield* Effect.result(options.capacity.memory));
        const storage = options.capacity && (yield* Effect.result(options.capacity.storage));
        return {
            ...current,
            capacity: options.capacity && {
                memory: memory?._tag === "Success" ? memory.success : undefined,
                storage: storage?._tag === "Success" ? storage.success : undefined,
                memoryError: memory?._tag === "Failure" ? "Memory estimate unavailable." : undefined,
                storageError: storage?._tag === "Failure" ? "Storage estimate unavailable." : undefined,
            },
            cache: current.cache && {
                ...current.cache,
                attachments: options.blobs && {
                    bytes: yield* options.blobs.usage.pipe(
                        Effect.mapError((cause) => classifyBackendFailure("replica.cache", cause))
                    ),
                    maxBytes:
                        options.cache?.attachments === false
                            ? undefined
                            : options.cache?.attachments?.maxBytes,
                    targetBytes:
                        options.cache?.attachments === false
                            ? undefined
                            : (options.cache?.attachments?.targetBytes ??
                              (options.cache?.attachments?.maxBytes === undefined
                                  ? undefined
                                  : Math.floor(options.cache.attachments.maxBytes * 0.8))),
                },
            },
            pin: pinned && {
                ready: pinned.ready,
                previousGraphRetained: pinned.previousGraphRetained,
                error: pinned.error,
            },
        };
    });
    const compile = (subset: ObjectSubset) => compileObjectSubset(options.ir, subset, options.context);
    const reads = (confirmed: boolean): ReplicaReads => ({
        get: (type, key) => (confirmed ? engine.confirmed : engine).get(type, key),
        readSubset: Effect.fn("Replica.readSubset")(function* (subset: ObjectSubset) {
            const scan = yield* compile(subset);
            return yield* (confirmed ? engine.confirmed : engine).loadSubset(scan.objectType, scan.query);
        }),
    });
    const control = (id: string) =>
        engine.pendingActions.pipe(
            Effect.map((entries) =>
                entries.some((entry) => entry.invocation.id === id && entry.forwarding)
                    ? engine
                    : (options.source?.outbox ?? engine)
            )
        );
    const resolveLocally = Effect.fn("Replica.resolveParameters")(function* (
        name: string,
        parameters: Record<string, unknown>
    ) {
        return yield* Effect.scoped(
            Effect.gen(function* () {
                const scope = yield* Effect.scope;
                const loadSubset = (type: string, query?: Query) =>
                    Scope.provide(
                        Effect.gen(function* () {
                            const subset = { objectType: type, query };
                            yield* engine.demand(subset);
                            yield* engine.syncSubset(subset);
                            return yield* engine.confirmed.loadSubset(type, query);
                        }),
                        scope
                    );
                return yield* resolveReadActionParameters({
                    ir: options.ir,
                    name,
                    parameters,
                    context: options.context,
                    read: {
                        loadSubset,
                        get: (type, key) => {
                            const object = options.ir.objectTypes.find((object) => object.name === type);
                            return object
                                ? Effect.map(
                                      loadSubset(type, {
                                          where: eq(field(object.primaryKey), key),
                                          limit: 1,
                                      }),
                                      (rows) => rows[0]?.value
                                  )
                                : engine.confirmed.get(type, key);
                        },
                    },
                });
            })
        );
    });
    const service: ReplicaService & { readonly [kernel]: KernelService } = {
        [kernel]: engine,
        ...reads(false),
        ir: engine.ir,
        context: options.context ?? {},
        sourceId: engine.sourceId,
        upstreamKind: options.source ? "speculative" : "committed",
        network: engine.connectivity,
        authentication: engine.connection,
        decrypt: decryption.decrypt,
        attachments,
        actions: {
            resolveParameters: (name, parameters) =>
                options.backend?.resolveActionParameters
                    ? options.backend.resolveActionParameters(name, parameters)
                    : resolveLocally(name, parameters),
            validate: (name, parameters, settings) =>
                options.backend?.validateAction
                    ? options.backend.validateAction(name, parameters, settings)
                    : Effect.succeed({ certain: false as const }),
            apply: Effect.fn("Replica.applyAction")(function* (request, settings) {
                if ((settings?.mode ?? "direct") === "direct" && !(yield* engine.connectivity.online))
                    return yield* new BackendError({
                        operation: "applyAction",
                        kind: "Unavailable",
                        message: "Direct actions require connectivity. Use outbox mode to queue offline.",
                        retryable: true,
                        actionOutcome: "not-committed",
                    });
                yield* service.outbox.enqueue(request, { optimistic: settings?.optimistic });
                const receipt = yield* service.outbox.wait(request.id);
                if (!receipt)
                    return yield* new BackendError({
                        operation: "applyAction",
                        kind: "ResultExpired",
                        message: "Action result is unavailable.",
                        retryable: false,
                        actionOutcome: "unknown",
                    });
                return receipt;
            }),
        },
        confirmed: reads(true),
        observeSubset: (subset) =>
            Stream.unwrap(
                Effect.map(compile(subset), (scan) => engine.observeRows(scan.objectType, scan.query))
            ),
        demand: {
            setPin: pin.setPin,
            clearPin: pin.clearPin(),
            pinStatus: pin.pinStatus,
            acquire: Effect.fn("Replica.demand")(function* (
                subset: ObjectSubset,
                settings?: { readonly localOnly?: boolean }
            ) {
                const scan = yield* compile(subset);
                if (settings?.localOnly) return yield* engine.retainLocal(scan.objectType, scan.query);
                yield* engine.demand(scan);
                yield* engine.syncSubset(scan);
            }),
        },
        outbox: {
            enqueue:
                options.live === false
                    ? () =>
                          Effect.fail(
                              new BackendError({
                                  operation: "outbox.enqueue",
                                  kind: "InvalidConfiguration",
                                  retryable: false,
                                  message:
                                      "One-shot replicas do not accept new outbox actions. Apply actions directly through the upstream backend.",
                              })
                          )
                    : engine.enqueue,
            entries: engine.pendingActions,
            observe: (ids) =>
                Stream.unwrap(
                    Effect.gen(function* () {
                        yield* engine.retainActions(ids);
                        const changes = yield* engine.subscribeChanges;
                        const entries = engine.pendingActions.pipe(
                            Effect.map((rows) =>
                                ids ? rows.filter((row) => ids.includes(row.invocation.id)) : rows
                            )
                        );
                        return Stream.concat(
                            Stream.fromEffect(entries),
                            Stream.mapEffect(changes, () => entries)
                        );
                    })
                ),
            get: engine.actionStatus,
            wait: engine.awaitAction,
            edit: (id, request) => control(id).pipe(Effect.flatMap((target) => target.edit(id, request))),
            retry: (id, settings) => control(id).pipe(Effect.flatMap((target) => target.retry(id, settings))),
            remove: (id, settings) =>
                control(id).pipe(
                    Effect.flatMap((target) =>
                        target
                            .remove(id, settings)
                            .pipe(
                                Effect.andThen(
                                    target === engine ? Effect.void : engine.acknowledgeParentRemoval(id)
                                )
                            )
                    )
                ),
        },
        status: {
            get: status,
            changes: Stream.merge(engine.statuses.pipe(Stream.as(undefined)), pin.changes).pipe(
                Stream.mapEffect(() => status)
            ),
        },
        syncOnce: engine.syncOnce.pipe(Effect.andThen(pin.refresh)),
        collectGarbage: engine.collectGarbage,
    } satisfies ReplicaService & { readonly [kernel]: KernelService };
    return service;
});
