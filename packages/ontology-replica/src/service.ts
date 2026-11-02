import { BackendError } from "@party-stack/ontology-backend";
import { executeAction } from "@party-stack/ontology-backend/actions";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { Effect, Stream } from "effect";
import { makeReplicaKernel } from "./engine.js";
import { kernel } from "./internal.js";
import { makeQueryPin } from "./pins.js";
import type { DemandPolicy } from "./demandCache.js";
import type {
    ReplicaService as KernelService,
    ObjectCacheGcPolicy,
    ObjectCacheSweepOptions,
} from "./engine.js";
import type { PinOptions, PinStatus } from "./pins.js";
import type { ReplicaStatus } from "./status.js";
import type { ReplicaRowsBatch } from "./visible.js";
import type { ConnectionMonitor } from "@party-stack/connect";
import type {
    ActionReceipt,
    ActionRequest,
    OntologyBackendService,
    BackendAttachments,
} from "@party-stack/ontology-backend";
import type { ActionMutatorRegistry } from "@party-stack/ontology-backend/actions";
import type { ClientPolicy } from "@party-stack/ontology-backend/clients";
import type { OntologySource, PendingAction } from "@party-stack/ontology-backend/protocol";
import type { QueryDocument } from "@party-stack/ontology-spec";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { ObjectSubset } from "@party-stack/ontology-spec/query";
import type { Key, Row } from "@party-stack/ontology-storage";
import type { BlobStorageService } from "@party-stack/ontology-storage/blobs";
import type { TablesService } from "@party-stack/ontology-storage/tables";
import type { NetworkConnectivity } from "@party-stack/runtime";
import type { Scope } from "effect";

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
    readonly objectCacheGc?: false | ObjectCacheGcPolicy;
}
export type ReplicaOutboxPolicy = NonNullable<ReplicaConfiguration["outbox"]>;
export type ReplicaOptions = ReplicaConfiguration & {
    readonly namespace: string;
    readonly tables: TablesService;
    readonly attachments?: Pick<BackendAttachments, "read">;
    readonly blobs?: BlobStorageService;
    readonly network?: NetworkConnectivity;
    readonly authentication?: Pick<ConnectionMonitor, "state" | "changes">;
} & (
        | { readonly backend: OntologyBackendService; readonly source?: never }
        | { readonly source: OntologySource; readonly backend?: never }
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
    readonly reconcile: (id: string, receipt: ActionReceipt) => Effect.Effect<void, BackendError>;
}
export interface ReplicaService extends ReplicaReads {
    readonly ir: OntologyIR;
    readonly sourceId: string;
    readonly upstreamKind: "committed" | "speculative";
    readonly network: NetworkConnectivity;
    readonly authentication?: Pick<ConnectionMonitor, "state" | "changes">;
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
    const engine = yield* makeReplicaKernel({
        ...options,
        startSync: options.live !== false,
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
    const pin = yield* makeQueryPin({
        ...options,
        engine,
        live: options.live !== false,
        attachments: options.attachments ?? options.backend?.attachments,
    });
    const status = Effect.gen(function* () {
        const current = yield* engine.status;
        const pinned = yield* pin.pinStatus;
        return {
            ...current,
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
    const service = {
        [kernel]: engine,
        ...reads(false),
        ir: engine.ir,
        sourceId: engine.sourceId,
        upstreamKind: options.source ? "speculative" : "committed",
        network: engine.connectivity,
        authentication: engine.connection,
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
            edit: engine.edit,
            retry: engine.retry,
            remove: engine.remove,
            reconcile: engine.reconcile,
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
