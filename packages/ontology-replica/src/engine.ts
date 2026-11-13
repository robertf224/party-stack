import { isUnknownActionOutcome } from "@party-stack/ontology-backend";
import { objectSubset, resolveSubsetSnapshot, coversSubset } from "@party-stack/ontology-backend/subset";
import {
    ontologyDefinitionSignature,
    ontologyDefinitionContractSignature,
    ontologyDefinitionContractHash,
} from "@party-stack/ontology-storage";
import { tableUsage } from "@party-stack/ontology-storage/tables";
import { alwaysOnlineConnectivity } from "@party-stack/runtime";
import type { ConnectionMonitor } from "@party-stack/connect";
import type { DeliveryPosition } from "@party-stack/ontology-backend/delivery";
import type { CompiledSubset } from "@party-stack/ontology-backend/subset";
import type { NetworkConnectivity } from "@party-stack/runtime";
export { makeCachedProxy } from "./proxy.js";
import { BackendError, classifyBackendFailure, ActionReceiptSchema } from "@party-stack/ontology-backend";
import { clientRegistry } from "@party-stack/ontology-backend/clients";
import {
    makeDeliveryManager,
    makeDeliveryReceiver,
    scanSelectedRows,
    scanDeliveryRows,
    deliveryKey,
    type DeliveryFrame,
    type DeliveryMetadata,
    type DeliveryPolicy,
    type DeliveryRecord,
    type DeliverySubscription,
} from "@party-stack/ontology-backend/delivery";
import { stateIdentity } from "@party-stack/ontology-backend/protocol";
import { compileEffectSchemas } from "@party-stack/ontology-spec/effect";
import { resolveType } from "@party-stack/ontology-spec/utils";
import { setAtPath } from "@party-stack/ontology-spec/utils";
import {
    evaluateQuery,
    withObjectSources,
    field,
    eq,
    inArray,
    indexesForQuery,
    lte,
    OntologyStorageError,
    ConfigurationError,
    TransactionError,
} from "@party-stack/ontology-storage";
import {
    digestBytes,
    BlobStorageError,
    collectObjectAttachments,
    collectActionAttachments,
    type BlobStorageService,
} from "@party-stack/ontology-storage/blobs";
import {
    overlay,
    getVisible,
    getBaseline,
    loadVisible,
    putVisible,
    deleteVisible,
} from "@party-stack/ontology-storage/overlay";
import { Table, type ReadTable } from "@party-stack/ontology-storage/tables";
import {
    Clock,
    Context,
    Deferred,
    Effect,
    Exit,
    PubSub,
    Queue,
    Redacted,
    Schema,
    Semaphore,
    Scope,
    Stream,
    Tracer,
} from "effect";
import { hasWindow, isWholeCollection, primaryKeyLookup } from "./coverage.js";
import { cachedCopy, withCachedCopy, encryptedCacheCodec, preserveCachedCopies } from "./encryptedCache.js";
import { makeReplicaDiagnostics } from "./status.js";
import type { ReplicaLoad, ReplicaStatus } from "./status.js";

// Local selection fencing is execution context, never part of the provider's
// immutable batch bytes or persisted replay fingerprint.
const deliveryGeneration = Context.Reference<number | undefined>(
    "@party-stack/ontology-replica/deliveryGeneration",
    { defaultValue: () => undefined }
);
import type { Encrypted } from "@party-stack/ontology-spec/values";
export { ReplicaStatusSchema, makeReplicaMonitor } from "./status.js";
export type { ReplicaStatus, ReplicaLoad, ReplicaMonitor } from "./status.js";
import { objectTypesWithAttachments } from "./attachmentCapability.js";
import { makeDemandCache, type DemandPolicy } from "./demandCache.js";
import { putIncomingRow, putIncomingBaseRows } from "./incoming.js";
import { connectReplicaParent, connectReplicaDelivery } from "./parent.js";
import { primaryKeyQueries, primaryKeyTableQuery } from "./primaryKeyOrder.js";
import { deliveryRecovery } from "./recovery.js";
import { superviseWatch } from "./watch.js";
export type { DemandPolicy } from "./demandCache.js";
import { affectsCoverage, markQuery, retentionQuery } from "./retention.js";
import { trackVisible, observeRows, type VisibleCommit, type ReplicaRowsBatch } from "./visible.js";
import type { ActionRequest, ActionReceipt, OntologyBackendService } from "@party-stack/ontology-backend";
import type {
    ClientLease,
    ClientPolicy,
    ClientSession,
    ClientToken,
} from "@party-stack/ontology-backend/clients";
import type { OwnedReadTransaction, OwnedTransaction } from "@party-stack/ontology-backend/owned";
import type {
    ClientState,
    ClientSubmission,
    ClientView,
    OntologySource,
    PendingAction,
    ReplicaStateSnapshot,
} from "@party-stack/ontology-backend/protocol";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { Cursor, Index, Key, Query, Row, Predicate } from "@party-stack/ontology-storage";
import type { Overlay, Override } from "@party-stack/ontology-storage/overlay";
import type { ReadTransaction, TablesService, Transaction } from "@party-stack/ontology-storage/tables";

export { connectReplicaParent, replicaStateSource } from "./parent.js";
export type { ParentConnection } from "./parent.js";
export type {
    ClientState,
    ClientSubmission,
    ClientView,
    OntologySource,
    PendingAction,
    ReplicaStateSnapshot,
    StateSelection,
} from "@party-stack/ontology-backend/protocol";
export { ClientTokenSchema, ClientSessionSchema } from "@party-stack/ontology-backend/clients";
export type {
    ClientLease,
    ClientSession,
    ClientToken,
    ClientPolicy,
} from "@party-stack/ontology-backend/clients";
type ObjectValue = Record<string, unknown>;
interface Position {
    cursor?: string;
    sequence: number;
    source: string;
    signature: string;
    mode?: "parent";
    parentClient?: ClientToken;
    parentSubmissionSequence?: number;
    parentViewGeneration?: number;
    parentViewIdentity?: string;
    deliverySelection?: string;
    deliveryMembershipVersion?: 1;
    deliveryResident?: boolean;
}
interface Coverage {
    complete?: boolean;
    subset: CompiledSubset;
    snapshotCursor?: string;
    barrierCursor?: string;
    rowKeys?: readonly Key[];
    updatedAt: number;
    invalidated?: boolean;
}
interface Retention {
    objectType: string;
    key: Key;
    accessedAt: number;
}
export type {
    ActionWaitOptions,
    ReplicaOutboxPolicy,
    ObjectCacheSweepOptions,
    ObjectCacheGcPolicy,
} from "./policies.js";
import type {
    ActionWaitOptions,
    ReplicaOutboxPolicy,
    ObjectCacheSweepOptions,
    ObjectCacheGcPolicy,
} from "./policies.js";
export interface ReplicaService extends OwnedReadTransaction {
    readonly localTransaction: <A>(
        body: (
            tx: Transaction,
            read: OwnedReadTransaction
        ) => Effect.Effect<A, BackendError | OntologyStorageError>
    ) => Effect.Effect<A, BackendError>;
    readonly visibleChanges: Effect.Effect<Stream.Stream<void>, BackendError, Scope.Scope>;
    readonly visibleRevision: (tx: ReadTransaction) => Effect.Effect<number, OntologyStorageError>;
    /** Read a local observation fence from this replica's own storage. */
    readonly readVisibleRevision: Effect.Effect<number, BackendError>;
    readonly hasCoverage: (
        tx: ReadTransaction,
        subset: CompiledSubset
    ) => Effect.Effect<boolean, OntologyStorageError>;

    readonly ir: OntologyIR;
    readonly mode: "adapter" | "protocol";
    readonly connectivity: NetworkConnectivity;
    readonly connection?: ConnectionMonitor;
    /** Shared by transient server wrappers; a failed cache repair survives endpoint release. */
    readonly proxyInvalidation: {
        writeGeneration: number;
        invalidatedGeneration: number;
        dirtyTypes: readonly string[] | undefined;
    };
    /** Read-only diagnostics; inspecting never acquires remote demand. */
    readonly status: Effect.Effect<ReplicaStatus, BackendError>;
    readonly statuses: Stream.Stream<ReplicaStatus, BackendError>;
    /** Stable identity of the state this Replica can expose to its own consumers. */
    readonly sourceId: string;
    /** Reads the confirmed baseline without optimistic overrides. Neither read path acquires remote demand. */
    readonly confirmed: OwnedReadTransaction;
    readonly snapshotSubset: (
        subset: CompiledSubset,
        confirmed?: boolean
    ) => Effect.Effect<import("@party-stack/ontology-backend").BackendSnapshot, BackendError>;
    /** Private device-encrypted copies, stored on existing base rows. Never creates or retains rows. */
    readonly encryptedCache: {
        readonly get: (value: Encrypted) => Effect.Effect<Encrypted | undefined, BackendError>;
        readonly put: (value: Encrypted, local: Encrypted) => Effect.Effect<void, BackendError>;
    };
    readonly changes: Stream.Stream<void>;
    readonly reportReplicationFailure: (error?: BackendError) => Effect.Effect<void>;
    readonly reportWatchFailure: (error?: BackendError) => Effect.Effect<void>;
    readonly observeRows: (
        objectType: string,
        query?: Query
    ) => Stream.Stream<ReplicaRowsBatch, BackendError>;
    /** Acquires the subscription before reading an initial snapshot. */
    readonly subscribeChanges: Effect.Effect<Stream.Stream<void>, BackendError, Scope.Scope>;
    readonly pending: Effect.Effect<readonly PendingAction[], BackendError>;
    /** Observed parent actions plus the local tail, with forwarding stage captured in the same read.
     * Parent visibility follows retainActions leases. Forwarding is not upstream execution. */
    readonly pendingActions: Effect.Effect<
        readonly (PendingAction & { readonly forwarding: boolean })[],
        BackendError
    >;
    readonly snapshotState: Effect.Effect<ReplicaStateSnapshot, BackendError>;
    readonly subscribeSelection: (
        selection: import("@party-stack/ontology-backend/protocol").StateSelection,
        policy?: DeliveryPolicy,
        resume?: DeliveryPosition
    ) => Effect.Effect<DeliverySubscription, BackendError, Scope.Scope>;
    readonly subscribeClient: (
        session: ClientSession,
        view: ClientView,
        policy?: DeliveryPolicy,
        resume?: DeliveryPosition
    ) => Effect.Effect<DeliverySubscription, BackendError, Scope.Scope>;
    readonly resetParentDelivery: Effect.Effect<void, BackendError>;
    readonly receiveDelivery: (
        frame: DeliveryFrame,
        generation?: number
    ) => Effect.Effect<
        | {
              position: import("@party-stack/ontology-backend/delivery").DeliveryPosition;
              metadata: DeliveryMetadata;
              duplicate: boolean;
          }
        | undefined,
        BackendError
    >;
    readonly openParentDelivery: (
        source?: OntologySource
    ) => Effect.Effect<
        { subscription: DeliverySubscription; generation: number; session?: ClientLease },
        BackendError,
        Scope.Scope
    >;
    readonly parentDeliveryGeneration: Effect.Effect<number, BackendError>;
    readonly openClient: (resume?: ClientToken) => Effect.Effect<ClientLease, BackendError>;
    readonly readClient: (
        session: ClientSession,
        view?: ClientView
    ) => Effect.Effect<ClientState, BackendError>;
    readonly acknowledgeDelivery: (
        position: import("@party-stack/ontology-backend/delivery").DeliveryPosition,
        speculative?: boolean
    ) => Effect.Effect<void, BackendError>;
    readonly acceptClient: (request: ClientSubmission) => Effect.Effect<void, BackendError>;
    readonly submitClient: (request: ClientSubmission) => Effect.Effect<ClientState, BackendError>;
    readonly acknowledgeClient: (
        session: ClientSession,
        revision: number,
        through: number,
        viewGeneration?: number
    ) => Effect.Effect<void, BackendError>;
    readonly collectClientGarbage: Effect.Effect<number, BackendError>;
    readonly parentState: Effect.Effect<ReplicaStateSnapshot | undefined, BackendError>;
    readonly receiveParentState: (
        snapshot: ReplicaStateSnapshot,
        requestedActionIds?: readonly string[],
        proofs?: ClientState["coverage"]
    ) => Effect.Effect<void, BackendError>;
    readonly refreshParent: (source: OntologySource) => Effect.Effect<void, BackendError>;
    /** Refresh observed state and forward only locally owned actions, in order. */
    readonly syncParent: (source: OntologySource) => Effect.Effect<void, BackendError>;
    /** Internal outbox worker; parent reads are limited to handoff/outcome recovery. */
    readonly forwardParentActions: (source: OntologySource) => Effect.Effect<void, BackendError>;
    /** One internal action signal, consumed by either the adapter or parent outbox worker. */
    readonly outboxWakeups: Queue.Queue<void>;
    readonly receipt: (id: string) => Effect.Effect<ActionReceipt | undefined, BackendError>;
    readonly actionStatus: (id: string) => Effect.Effect<
        {
            readonly pending?: PendingAction;
            readonly receipt?: ActionReceipt;
            /** A retained terminal rejection, separate from the pending outbox. */
            readonly error?: BackendError;
            /** The installed state establishes immediate-parent acceptance. Storage
             * durability and the business completion boundary are source guarantees.
             */
            readonly parentAcceptance?: { readonly sourceId: string };
        },
        BackendError
    >;
    /** Scoped observation only. Interrupting a wait never cancels or resubmits the action. */
    readonly awaitAction: (
        id: string,
        options?: ActionWaitOptions
    ) => Effect.Effect<ActionReceipt | undefined, BackendError>;
    /** Install an independently verified receipt, then use ordinary read-back/journal settlement. */
    readonly reconcile: (id: string, receipt: ActionReceipt) => Effect.Effect<void, BackendError>;
    readonly enqueue: (
        invocation: ActionRequest,
        options?: { optimistic?: boolean }
    ) => Effect.Effect<PendingAction, BackendError>;
    /** Release handoff bookkeeping only after an owning parent acknowledges removal. */
    readonly acknowledgeParentRemoval: (id: string) => Effect.Effect<void, BackendError>;
    readonly remove: (
        id: string,
        options?: { allowUnknownOutcome?: boolean }
    ) => Effect.Effect<void, BackendError>;
    readonly edit: (id: string, invocation: ActionRequest) => Effect.Effect<void, BackendError>;
    readonly retry: (
        id: string,
        options?: { allowUnknownOutcome?: boolean }
    ) => Effect.Effect<void, BackendError>;
    readonly demand: (subset: CompiledSubset) => Effect.Effect<void, BackendError, Scope.Scope>;
    readonly retainLocal: (
        objectType: string,
        query?: Query
    ) => Effect.Effect<void, BackendError, Scope.Scope>;
    /** Explicit privileged action inspection; omitted IDs request the retained action view. */
    readonly retainActions: (ids?: readonly string[]) => Effect.Effect<void, BackendError, Scope.Scope>;
    readonly pin: (objectType: string, key: Key, pinned: boolean) => Effect.Effect<void, BackendError>;
    /** Explicit full checkpoint: refresh state and process pending actions. Not a read-readiness API. */
    readonly syncOnce: Effect.Effect<void, BackendError>;
    /** Refresh state only, or accept a retained previous confirmation. Never submits actions. */
    readonly syncSubset: (
        subset: CompiledSubset,
        settings?: { readonly resultType?: "cached" | "complete" }
    ) => Effect.Effect<void, BackendError>;
    readonly invalidate: (objectTypes?: readonly string[]) => Effect.Effect<void, BackendError>;
    readonly ensureIndex: (objectType: string, index: Index) => Effect.Effect<void, BackendError>;
    readonly collectGarbage: (options?: ObjectCacheSweepOptions) => Effect.Effect<number, BackendError>;
    readonly wake: Effect.Effect<void>;
}
interface ReplicaCommonOptions {
    readonly namespace: string;
    readonly ir: OntologyIR;
    readonly context?: Record<string, unknown>;
    readonly tables: TablesService;
    readonly blobs?: BlobStorageService;
    /** Receives only a persisted local transaction. Return resolved defaults to freeze them at enqueue. */
    readonly execute: (
        tx: OwnedTransaction,
        invocation: ActionRequest,
        options?: { readonly optimistic: boolean }
    ) => Effect.Effect<void | ObjectValue, BackendError>;
    /** Idempotent local receipt application. Runs only after the receipt is durable; failures retry without dispatch. */
    readonly onReceipt?: (receipt: ActionReceipt) => Effect.Effect<void, BackendError>;
    readonly connectivity?: NetworkConnectivity;
    readonly connection?: ConnectionMonitor;
    /** Private controller scheduling switch for deterministic state-machine fixtures. */
    readonly startSync?: boolean;
    readonly live?: boolean;
    readonly clients?: ClientPolicy;
    readonly resultRetentionMs?: number;
    readonly pollIntervalMs?: number;
    readonly demand?: DemandPolicy;
    readonly outbox?: ReplicaOutboxPolicy;
    /** Replica cache eviction only; owned storage is never collected by this policy. */
    readonly objectCacheGc?: false | ObjectCacheGcPolicy;
    readonly storeBroaderSubsets?: boolean;
    readonly publish?: Effect.Effect<void>;
}
/** Use a provider/owned backend binding or a protocol source, never both.
 * Both paths own ordinary local row and attachment retention.
 */
export type ReplicaOptions = ReplicaCommonOptions &
    (
        | { readonly backend: OntologyBackendService; readonly source?: never }
        | { readonly source: OntologySource; readonly backend?: never }
    );
const fault = (kind: BackendError["kind"], message: string, cause?: unknown) =>
    new BackendError({ operation: "replica", kind, message, retryable: kind === "Unavailable", cause });
const stateRetryDelayMs = 5_000;
const confirmationRetryDelayMs = 5_000;
const maintenanceIntervalMs = 60_000;
const boundary = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    work.pipe(Effect.mapError((cause) => classifyBackendFailure("replica.storage", cause)));
const identity = (type: string, key: Key) => JSON.stringify([type, key]);
const canonicalSubset = (subset: CompiledSubset): CompiledSubset => {
    // Optional query/order settings can be omitted by wire schemas. Undefined
    // predicate operands remain meaningful and must retain their identity.
    const defined = (value: object) =>
        Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
    const query = defined(subset.query ?? {});
    const predicate = (value: Predicate): Predicate => {
        if (value.op === "in") {
            const codec = Table.make<unknown>({ name: "subset-values" });
            return {
                ...value,
                values: [...new Map(value.values.map((item) => [codec.encode(item), item]))]
                    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                    .map(([, item]) => item),
            };
        }
        if (value.op === "and" || value.op === "or")
            return { ...value, predicates: value.predicates.map(predicate) };
        if (value.op === "not") return { ...value, predicate: predicate(value.predicate) };
        return value;
    };
    if (subset.query?.where) query.where = predicate(subset.query.where);
    if (subset.query?.orderBy) query.orderBy = subset.query.orderBy.map(defined);
    return {
        objectType: subset.objectType,
        query,
    };
};
const subsetKey = (subset: CompiledSubset) =>
    Table.make<CompiledSubset>({ name: "subset-identity" }).encode(canonicalSubset(subset));

// Keep a bounded identity witness, not another retained copy of the parent's rows.
const snapshotDigest = Effect.fnUntraced(function* (snapshot: ReplicaStateSnapshot) {
    const encoded = yield* Effect.try({
        try: () => new TextEncoder().encode(stateIdentity(snapshot)),
        catch: (cause) => fault("InvalidResponse", "Invalid parent state.", cause),
    });
    return yield* boundary(digestBytes({ type: "application/json", stream: Stream.make(encoded) }));
});

/** A scoped persistent Replica. Its replay capability cannot reach the backend. */
export const makeReplicaKernel = Effect.fn("Replica.make")(function* (options: ReplicaOptions) {
    const connectivity = options.connectivity ?? alwaysOnlineConnectivity;
    const connection = options.connection;
    const canSync = Effect.gen(function* () {
        return (yield* connectivity.online) && (!connection || connection.state.status === "active");
    });
    const awaitAuthentication = connection
        ? Effect.suspend(() =>
              connection.state.status === "active"
                  ? Effect.void
                  : connection.changes.pipe(
                        Stream.filter(() => connection.state.status === "active"),
                        Stream.runHead,
                        Effect.flatMap((active) => (active._tag === "Some" ? Effect.void : Effect.never))
                    )
          )
        : Effect.void;
    const maxCoverageAge = options.demand?.refresh?.maxCoverageAgeMs ?? 60_000;
    if (Number.isNaN(maxCoverageAge) || maxCoverageAge < 0)
        return yield* fault("InvalidConfiguration", "Coverage age must be nonnegative or Infinity.");
    const maxRetries = options.outbox?.maxRetries ?? 3;
    const retryDelayMs = options.outbox?.retryDelayMs ?? 1_000;
    if (
        !Number.isSafeInteger(maxRetries) ||
        maxRetries < 0 ||
        !Number.isFinite(retryDelayMs) ||
        retryDelayMs < 0 ||
        retryDelayMs > 60_000
    )
        return yield* fault("InvalidConfiguration", "Invalid outbox retry policy.");
    if (
        options.resultRetentionMs !== undefined &&
        (options.resultRetentionMs <= 0 || Number.isNaN(options.resultRetentionMs))
    )
        return yield* fault("InvalidConfiguration", "Result retention must be positive.");
    // Delivery producers are consumed by RPC fibers outside the acquisition scope.
    // Keep their spans on the owning replica's configured tracer.
    const deliveryTracer = yield* Tracer.Tracer;
    const traceDelivery = (work: Effect.Effect<DeliverySubscription, BackendError, Scope.Scope>) =>
        work.pipe(
            Effect.provideService(Tracer.Tracer, deliveryTracer),
            Effect.map((subscription) => ({
                ...subscription,
                frames: subscription.frames.pipe(Stream.provideService(Tracer.Tracer, deliveryTracer)),
            }))
        );
    const adapter = options.backend;
    const sourceId = options.source?.sourceId ?? adapter!.sourceId;
    const backendEffect = adapter
        ? Effect.succeed(adapter)
        : Effect.fail(fault("NotImplemented", "This Replica receives state through its protocol source."));
    const name = (part: string) => JSON.stringify(["replica", options.namespace, part]);
    const committedDeliveries = yield* makeDeliveryManager({
        tables: options.tables,
        namespace: name("committed"),
    });
    const speculativeDeliveries = yield* makeDeliveryManager({
        tables: options.tables,
        namespace: name("speculative"),
    });
    const stateHead = Table.make<{ sourceId: string; revision: number; visibleRevision?: number }>({
        name: name("state-head"),
    });
    const imported = Table.make<
        Omit<ReplicaStateSnapshot, "objects" | "pending" | "completed"> & {
            /** Digest fences reused revisions even when local cache rows have been evicted. */
            digest?: string;
            resident?: boolean;
        }
    >({
        name: name("parent-head"),
    });
    const importedPending = Table.make<PendingAction>({ name: name("parent-pending") });
    const importedCompleted = Table.make<PendingAction>({ name: name("parent-completed") });
    const views = new Map<string, Overlay<ObjectValue>>();
    const primaryKeys = new Map<ReadTable<unknown>, string>();
    const visibleEvents = yield* PubSub.sliding<VisibleCommit>(16);
    yield* Effect.addFinalizer(() => PubSub.shutdown(visibleEvents));
    const cachePressure = yield* Queue.sliding<void>(1);
    yield* Effect.addFinalizer(() => Queue.shutdown(cachePressure));
    const usage = tableUsage({
        tables: () =>
            [...views.values()].flatMap((v) => [
                v.base,
                ...(v.inherited ? [v.inherited] : []),
                v.overrides,
            ]) as Table<unknown>[],
    });
    let closed = false;
    const open = Effect.suspend(() =>
        closed ? Effect.fail(fault("InvalidRequest", "Replica scope is closed.")) : Effect.void
    );
    yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
            closed = true;
        })
    );
    const tables: TablesService = {
        ...options.tables,
        query: primaryKeyTableQuery(options.tables.query, primaryKeys),
        read: (body) => options.tables.read((tx) => body(primaryKeyQueries(tx, primaryKeys))),
        transaction: (body) =>
            options.tables
                .transaction((tx) =>
                    Effect.gen(function* () {
                        // A caller can pass its entry guard and then wait for
                        // storage while this owner closes. Fence the actual
                        // transaction too, before admitting any old intent.
                        if (closed)
                            return yield* new OntologyStorageError({
                                operation: "replica.transaction",
                                reason: new TransactionError({
                                    kind: "Closed",
                                    retryable: false,
                                    message: "Replica scope is closed.",
                                }),
                            });
                        const tracked = trackVisible(primaryKeyQueries(tx, primaryKeys), views);
                        const result = yield* body(tracked.tx);
                        const delta = yield* tracked.finish;
                        const head = yield* tx.get(stateHead, "head");
                        if (head && !Number.isSafeInteger(head.revision + 1))
                            return yield* new OntologyStorageError({
                                operation: "replica.revision",
                                reason: new ConfigurationError({
                                    message: "Replica state revision exhausted.",
                                }),
                            });
                        const previous = head?.visibleRevision ?? 0;
                        const changed = delta.reset || delta.changes.length > 0;
                        const visibleRevision = previous + (changed ? 1 : 0);
                        yield* tx.put(stateHead, "head", {
                            sourceId: head?.sourceId ?? crypto.randomUUID(),
                            revision: (head?.revision ?? 0) + 1,
                            visibleRevision,
                        });
                        return {
                            result,
                            commit: changed ? { ...delta, previous, revision: visibleRevision } : undefined,
                        };
                    })
                )
                .pipe(
                    Effect.tap(({ commit }) =>
                        commit
                            ? PubSub.publish(visibleEvents, commit).pipe(
                                  Effect.andThen(
                                      options.objectCacheGc && options.objectCacheGc.maxBytes !== undefined
                                          ? Queue.offer(cachePressure, undefined)
                                          : Effect.void
                                  ),
                                  Effect.withSpan("Replica.visible.publish")
                              )
                            : Effect.void
                    ),
                    Effect.map(({ result }) => result)
                ),
    };
    const objectCacheGc =
        options.objectCacheGc === false
            ? undefined
            : {
                  maxBytes: options.objectCacheGc?.maxBytes,
                  targetBytes:
                      options.objectCacheGc?.targetBytes ??
                      (options.objectCacheGc?.maxBytes === undefined
                          ? undefined
                          : Math.floor(options.objectCacheGc.maxBytes * 0.8)),
                  sweepIntervalMs: options.objectCacheGc?.sweepIntervalMs ?? 60_000,
                  minUnusedAgeMs: options.objectCacheGc?.minUnusedAgeMs ?? 24 * 60 * 60 * 1000,
                  maxCandidates: options.objectCacheGc?.maxCandidates ?? 100,
              };
    if (
        objectCacheGc &&
        (!Number.isFinite(objectCacheGc.sweepIntervalMs) ||
            objectCacheGc.sweepIntervalMs < 10 ||
            !Number.isFinite(objectCacheGc.minUnusedAgeMs) ||
            objectCacheGc.minUnusedAgeMs < 0 ||
            !Number.isSafeInteger(objectCacheGc.maxCandidates) ||
            objectCacheGc.maxCandidates < 1 ||
            objectCacheGc.maxCandidates > 10_000)
    )
        return yield* fault("InvalidConfiguration", "Invalid automatic object cache GC policy.");
    const schemas = yield* Effect.try({
        try: () => compileEffectSchemas(options.ir),
        catch: (cause) => fault("InvalidConfiguration", "Invalid ontology definition.", cause),
    });
    const definitions = new Map(options.ir.objectTypes.map((type) => [type.name, type]));
    const encryptedProperties = new Map<string, readonly string[]>();
    for (const type of options.ir.objectTypes) {
        const properties = type.properties
            .filter((property) => {
                let resolved = resolveType(options.ir, property.type);
                while (resolved.kind === "optional") resolved = resolveType(options.ir, resolved.value.type);
                return resolved.kind === "encrypted";
            })
            .map((property) => property.name);
        encryptedProperties.set(type.name, properties);
        const schema = Schema.toEncoded(schemas.objectSchemas[type.name]!);
        const base = Table.make<ObjectValue>({
            name: name(`${options.source ? "parent-base" : "base"}:${type.name}`),
            codec: encryptedCacheCodec(
                { encode: Schema.encodeSync(schema), decode: Schema.decodeUnknownSync(schema) },
                properties
            ),
        });
        primaryKeys.set(base, type.primaryKey);
        const inherited = options.source
            ? overlay(base, { name: name(`parent-overlay:${type.name}`) }).overrides
            : undefined;
        views.set(type.name, overlay(base, { name: name(`overlay:${type.name}`), inherited }));
    }
    const attachmentTypes = objectTypesWithAttachments(options.ir);
    const blobGroup = (type: string, kind: "base" | "overlay") =>
        JSON.stringify(["replica-row", options.namespace, kind, type]);
    const retainRowBlobs = (
        tx: Transaction,
        type: string,
        key: Key,
        value: ObjectValue | undefined,
        kind: "base" | "overlay",
        additional?: ObjectValue
    ) => {
        if (!options.blobs || !attachmentTypes.has(type)) return Effect.void;
        const group = blobGroup(type, kind);
        const owner = JSON.stringify([group, key]);
        return value === undefined && additional === undefined
            ? options.blobs.in(tx).release(owner)
            : options.blobs.in(tx).retain(
                  owner,
                  [value, additional].flatMap((row) =>
                      row === undefined
                          ? []
                          : collectObjectAttachments(options.ir, type, row).map(
                                (entry) => entry.attachment.id
                            )
                  ),
                  { bytes: false, group }
              );
    };
    const clearRowBlobs = (tx: Transaction, type: string, kind: "base" | "overlay") =>
        options.blobs?.in(tx).releaseGroup(blobGroup(type, kind)) ?? Effect.void;
    // Acceptance moves the action into the received baseline, not another queue.
    type LocalAction = PendingAction & { includedInBase?: true };
    const publicAction = ({ includedInBase: _included, ...entry }: LocalAction): PendingAction => entry;
    const outbox = Table.make<LocalAction>({ name: name("outbox") });
    const acceptedIn = (tx: ReadTransaction) =>
        tx.query(outbox, {
            where: eq(field("includedInBase"), true),
        });
    const completed = Table.make<PendingAction>({ name: name("completed") });
    // A deduplicated invocation can return a receipt older than our current head.
    // Remember journal acknowledgments even when no local outbox entry existed yet.
    const journalReceipts = Table.make<ActionReceipt & { observedAt: number }>({
        name: name("journal-receipts"),
    });
    const metadata = Table.make<Position>({ name: name("position") });
    const coverage = Table.make<Coverage>({ name: name("coverage") });
    const retention = Table.make<Retention>({ name: name("retention") });
    const touch = Effect.fnUntraced(function* (tx: Transaction, objectType: string, key: Key) {
        yield* tx.put(retention, identity(objectType, key), {
            objectType,
            key,
            accessedAt: yield* Clock.currentTimeMillis,
        });
    });
    const roots = Table.make<{ owner: string; objectType: string; kind: "remote" | "reader"; query?: Query }>(
        {
            name: name("roots"),
        }
    );
    const actionRows = Table.make<{ action: string; objectType: string; key: Key; identity: string }>({
        name: name("action-rows"),
    });
    const actionQueries = Table.make<{ action: string; subset: CompiledSubset }>({
        name: name("action-queries"),
    });
    const sweep = Table.make<{ after?: Cursor; reclaiming?: boolean }>({ name: name("sweep") });
    const rootOwner = crypto.randomUUID();
    const rootScope = yield* Effect.scope;
    const rootCounts = new Map<string, number>();
    const rootGate = yield* Semaphore.make(1);
    const pins = Table.make<{ objectType: string; key: Key }>({ name: name("pins") });
    const signature = yield* Effect.try({
        try: () => ontologyDefinitionSignature(options.ir),
        catch: (cause) => fault("InvalidConfiguration", "Invalid ontology definition.", cause),
    });
    const contractSignature = yield* Effect.try({
        try: () => ontologyDefinitionContractSignature(options.ir),
        catch: (cause) => fault("InvalidConfiguration", "Invalid ontology definition.", cause),
    });
    const sameDefinitionContract = (stored: string) => {
        if (stored === signature) return true;
        try {
            const definition = Table.make<OntologyIR>({ name: "replica-definition" }).decode(stored);
            return ontologyDefinitionContractSignature(definition) === contractSignature;
        } catch {
            return false;
        }
    };
    const schemaHash = yield* boundary(ontologyDefinitionContractHash(options.ir));
    const deliveryActive =
        options.startSync !== false && Boolean(options.source?.subscribe || adapter?.subscribeSelection);
    const events = yield* PubSub.sliding<void>(1);
    const queue = yield* Queue.sliding<void>(1);
    const outboxWake = yield* Queue.sliding<void>(1);
    yield* Effect.addFinalizer(() => PubSub.shutdown(events));
    yield* Effect.addFinalizer(() => Queue.shutdown(queue).pipe(Effect.asVoid));
    yield* Effect.addFinalizer(() => Queue.shutdown(outboxWake).pipe(Effect.asVoid));
    const gate = yield* Semaphore.make(1);
    const demands = new Map<
        string,
        {
            subset: CompiledSubset;
            count: number;
            released: Deferred.Deferred<void>;
            revision: number;
            installed: number;
            watchers: number;
            watchReady?: Deferred.Deferred<void>;
            sourceReady?: Deferred.Deferred<void, BackendError>;
            watched?: boolean;
            loadFailure?: { readonly revision: number; readonly error: BackendError };
            watchFailure?: BackendError;
            coveredBy?: CompiledSubset;
            pollIntervalMs?: number;
            pollDisabled?: boolean;
            coverageProof?: ReplicaStatus["demands"][number]["coverageProof"];
        }
    >();
    const actionInterests = new Map<string, readonly string[] | undefined>();
    // Transient IO fences, bounded by the definition's object types. Durable
    // completeness lives in coverage; these only identify overlapping fetches.
    const coverageGenerations = new Map(options.ir.objectTypes.map((type) => [type.name, Symbol()]));
    const coverageFor = Effect.fnUntraced(function* (tx: ReadTransaction, subset: CompiledSubset) {
        const key = subsetKey(subset);
        const exact = yield* tx.get(coverage, key);
        if (exact?.complete && !exact.invalidated) return exact;
        const reused = demands.get(key)?.coveredBy;
        if (reused && subsetKey(reused) !== key && (!deliveryActive || demands.has(subsetKey(reused)))) {
            const covering = yield* tx.get(coverage, subsetKey(reused));
            if (covering?.complete && !covering.invalidated) return covering;
        }
        // A maintained live region can answer a new child selection before a
        // sync pass has assigned its coveredBy field. This applies to snapshot
        // adapters with healthy watches as well as incremental parent delivery.
        // Cached rows or a retired/polling/failed watch cannot prove readiness.
        for (const [candidateKey, candidate] of demands) {
            if (!coversSubset(subset, candidate.subset)) continue;
            if (
                !deliveryActive &&
                (candidate.watchers === 0 ||
                    candidate.pollIntervalMs !== undefined ||
                    candidate.watchFailure ||
                    candidate.installed !== candidate.revision)
            )
                continue;
            const record = yield* tx.get(coverage, candidateKey);
            if (record?.complete && !record.invalidated && coversSubset(subset, record.subset)) return record;
        }
        return exact;
    });
    // A previous confirmation is useful to readers even after a watch gap or
    // invalidation makes it stale. Residency is still required: collectors and
    // view replacement delete these proofs together with the data they protect.
    // This does not prove current completeness, including a bounded query's
    // current boundary after later changes to its retained rows.
    const cachedCoverageFor = Effect.fnUntraced(function* (tx: ReadTransaction, subset: CompiledSubset) {
        const exact = yield* tx.get(coverage, subsetKey(subset));
        if (exact?.complete) return exact;
        for (const { value: record } of yield* tx.query(coverage, {
            where: eq(field("subset", "objectType"), subset.objectType),
        }))
            if (record.complete && coversSubset(subset, record.subset)) return record;
        return undefined;
    });
    const view = (type: string) => {
        const found = views.get(type);
        return found
            ? Effect.succeed(found)
            : Effect.fail(fault("InvalidRequest", `Unknown object type ${JSON.stringify(type)}.`));
    };
    const putBase = Effect.fnUntraced(function* (
        tx: Transaction,
        type: string,
        key: Key,
        value: ObjectValue
    ) {
        const v = yield* view(type);
        const properties = encryptedProperties.get(type)!;
        yield* putIncomingRow(tx, v, definitions.get(type)!.primaryKey, properties, key, {
            kind: "base",
            value,
        });
    });
    const diagnostics = yield* makeReplicaDiagnostics();
    let authenticationGeneration = 0;
    const authentication = connection
        ? {
              awaitActive: awaitAuthentication,
              generation: Effect.sync(() => authenticationGeneration),
              awaitActivation: (after: number) =>
                  Effect.scoped(
                      Effect.gen(function* () {
                          const changes = yield* diagnostics.subscribe;
                          yield* Stream.concat(Stream.succeed(undefined), changes).pipe(
                              Stream.filter(
                                  () =>
                                      authenticationGeneration > after && connection.state.status === "active"
                              ),
                              Stream.runHead
                          );
                      })
                  ),
          }
        : undefined;
    let replicationError: ReplicaStatus["replicationError"];
    let changeWatchFailure: BackendError | undefined;
    let syncRetry: { readonly error: BackendError; readonly at: number } | undefined;
    const localNotify = PubSub.publish(events, undefined).pipe(
        Effect.andThen(diagnostics.changed),
        Effect.asVoid
    );
    const notify = options.publish ? localNotify.pipe(Effect.andThen(options.publish)) : localNotify;
    const wakeState = Effect.suspend(() =>
        closed ? Effect.void : Queue.offer(queue, undefined).pipe(Effect.asVoid)
    );
    const wakeOutbox = Effect.suspend(() =>
        closed ? Effect.void : Queue.offer(outboxWake, undefined).pipe(Effect.asVoid)
    );
    const wake = wakeState.pipe(Effect.andThen(wakeOutbox));
    const access = <A, E, R>(work: Effect.Effect<A, E, R>) => open.pipe(Effect.andThen(boundary(work)));
    const retainLease = (
        objectType: string,
        kind: "remote" | "reader",
        key: string,
        subset?: CompiledSubset
    ) =>
        Effect.acquireRelease(
            rootGate.withPermits(1)(
                boundary(
                    Effect.gen(function* () {
                        yield* open;
                        yield* view(objectType);
                        if (subset)
                            yield* Effect.try({
                                try: () => evaluateQuery([], subset.query ?? {}),
                                catch: (cause) => fault("InvalidRequest", "Invalid retention query.", cause),
                            });
                        const count = rootCounts.get(key) ?? 0;
                        if (!count)
                            yield* tables.put(roots, JSON.stringify([rootOwner, key]), {
                                owner: rootOwner,
                                objectType,
                                kind,
                                query: subset?.query,
                            });
                        rootCounts.set(key, count + 1);
                        if (kind === "remote" && subset) {
                            const current = demands.get(key);
                            if (current) current.count++;
                            else
                                demands.set(key, {
                                    subset,
                                    count: 1,
                                    released: yield* Deferred.make<void>(),
                                    revision: 1,
                                    installed: 0,
                                    watchers: 0,
                                    watchReady:
                                        !options.source && !deliveryActive && options.live !== false
                                            ? yield* Deferred.make<void>()
                                            : undefined,
                                });
                            yield* wakeState;
                        }
                        yield* diagnostics.changed;
                        if (options.source || deliveryActive) yield* localNotify;
                        return key;
                    })
                )
            ),
            (key) =>
                rootGate
                    .withPermits(1)(
                        Effect.gen(function* () {
                            const count = rootCounts.get(key) ?? 0;
                            if (count <= 1) {
                                yield* tables.delete(roots, JSON.stringify([rootOwner, key]));
                                rootCounts.delete(key);
                            } else rootCounts.set(key, count - 1);
                            if (kind === "remote" && subset) {
                                const current = demands.get(key);
                                if (current && current.count > 1) current.count--;
                                else {
                                    if (current?.watched) {
                                        coverageGenerations.set(objectType, Symbol());
                                        const previous = yield* tables.get(coverage, key);
                                        if (previous)
                                            yield* tables.put(coverage, key, {
                                                ...previous,
                                                invalidated: true,
                                            });
                                    }
                                    demands.delete(key);
                                    if (current) yield* Deferred.succeed(current.released, undefined);
                                }
                            }
                            yield* diagnostics.changed;
                            if (options.source || deliveryActive) yield* localNotify;
                        })
                    )
                    .pipe(Effect.orDie)
        ).pipe(Effect.asVoid);

    // A consumer may outlive the replica (for example a React inspector during
    // account switching). Either scope closes the same lease, exactly once,
    // before this replica's storage and notification services are released.
    const retain = Effect.fnUntraced(function* (...args: Parameters<typeof retainLease>) {
        const lease = yield* Effect.acquireRelease(Scope.fork(rootScope), (scope, exit) =>
            Scope.close(scope, exit)
        );
        yield* Scope.provide(retainLease(...args), lease).pipe(
            Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(lease, exit) : Effect.void))
        );
    });

    const pendingIn = (tx: ReadTransaction) =>
        tx
            .query(outbox, { orderBy: [{ field: field("sequence") }] })
            .pipe(
                Effect.map((rows) =>
                    rows.filter((row) => !row.value.includedInBase).map((row) => publicAction(row.value))
                )
            );
    const position = (tx: ReadTransaction) =>
        Effect.gen(function* () {
            const stored = yield* tx.get(metadata, "head");
            if (
                stored &&
                (stored.source !== sourceId || (stored.mode === "parent") !== Boolean(options.source))
            )
                return yield* fault(
                    "SourceMismatch",
                    "Replica source changed; reset this namespace explicitly."
                );
            if (stored && !sameDefinitionContract(stored.signature))
                return yield* fault(
                    "SchemaMismatch",
                    "Replica definition changed; migrate or reset this namespace explicitly."
                );
            return stored
                ? { ...stored, signature }
                : {
                      sequence: 0,
                      source: sourceId,
                      signature,
                      ...(options.source ? { mode: "parent" as const } : {}),
                  };
        });
    const reader = (tx: ReadTransaction, confirmed: boolean): OwnedReadTransaction => ({
        get: (type, key) =>
            boundary(
                Effect.gen(function* () {
                    const v = yield* view(type);
                    return yield* confirmed ? tx.get(v.base, key) : getVisible(tx, v, key);
                })
            ),
        loadSubset: (type, query) =>
            boundary(
                Effect.gen(function* () {
                    const v = yield* view(type);
                    return yield* confirmed ? tx.query(v.base, query) : loadVisible(tx, v, query);
                })
            ),
    });
    const clearActionRoots = Effect.fnUntraced(function* (tx: Transaction, id: string) {
        for (const row of yield* tx.query(actionRows, { where: eq(field("action"), id) }))
            yield* tx.delete(actionRows, row.key);
        for (const row of yield* tx.query(actionQueries, { where: eq(field("action"), id) }))
            yield* tx.delete(actionQueries, row.key);
    });
    const blobOwner = (id: string) => JSON.stringify(["replica", options.namespace, "outbox", id]);
    const attachmentIds = (invocation: ActionRequest) =>
        collectActionAttachments(options.ir, invocation.name, invocation.parameters).map(
            (entry) => entry.attachment.id
        );
    const deletePending = Effect.fnUntraced(function* (tx: Transaction, id: string) {
        yield* tx.delete(outbox, id);
        yield* clearActionRoots(tx, id);
        if (options.blobs) yield* options.blobs.in(tx).release(blobOwner(id));
    });
    // One action stages its changes in memory. A rejected action cannot leave partial overrides.
    const replay = Effect.fn("Replica.replay")(function* (tx: Transaction, entry: PendingAction) {
        const staged = new Map<string, { type: string; key: Key; value?: ObjectValue }>();
        const keys = new Map<string, { objectType: string; key: Key }>();
        const queries = new Map<string, CompiledSubset>();
        const rememberKey = (objectType: string, key: Key) =>
            keys.set(identity(objectType, key), { objectType, key });
        let active = true;
        const guard = <A, E>(effect: Effect.Effect<A, E>) =>
            Effect.suspend<A, E | BackendError, never>(() =>
                active ? effect : Effect.fail(fault("InvalidRequest", "Replay transaction is closed."))
            );
        const read = reader(tx, false);
        const local: OwnedTransaction = {
            patch: (type, key, patches) =>
                guard(
                    Effect.gen(function* () {
                        let value = yield* local.get(type, key);
                        if (!value) return yield* fault("NotFound", "Object not found.");
                        for (const patch of patches) {
                            if (!patch.path.length)
                                return yield* fault("InvalidRequest", "Patch paths cannot be empty.");
                            value = yield* Effect.try({
                                try: () => setAtPath(value!, patch.path, patch.value),
                                catch: (cause) => fault("InvalidRequest", "Invalid patch path.", cause),
                            });
                        }
                        if (value[definitions.get(type)!.primaryKey] !== key)
                            return yield* fault(
                                "InvalidRequest",
                                "Patches cannot change an object's identity."
                            );
                        yield* local.put(type, value);
                    })
                ),
            get: (type, key) =>
                guard(
                    Effect.suspend(() => {
                        const own = staged.get(identity(type, key));
                        rememberKey(type, key);
                        return own ? Effect.succeed(own.value) : read.get(type, key);
                    })
                ),
            loadSubset: (type, query: Query = {}) =>
                guard(
                    Effect.gen(function* () {
                        const subset = { objectType: type, query };
                        queries.set(subsetKey(subset), subset);
                        const prefix = retentionQuery(query);
                        const rows = new Map(
                            (yield* read.loadSubset(type, {
                                ...prefix,
                                limit: prefix.limit === undefined ? undefined : prefix.limit + staged.size,
                            })).map((row) => [row.key, row])
                        );
                        for (const write of staged.values())
                            if (write.type === type) {
                                if (write.value === undefined) rows.delete(write.key);
                                else rows.set(write.key, { key: write.key, value: write.value });
                            }
                        const result = yield* Effect.try({
                            try: () => evaluateQuery([...rows.values()], query),
                            catch: (cause) => fault("InvalidRequest", "Invalid replay query.", cause),
                        });
                        for (const row of result) rememberKey(type, row.key);
                        return result;
                    })
                ),
            put: (type, value) =>
                guard(
                    Effect.gen(function* () {
                        const v = yield* view(type);
                        const copy = yield* Effect.try({
                            try: () => v.base.decode(v.base.encode(value)),
                            catch: () => fault("Internal", "Mutation does not match the object definition."),
                        });
                        const key = copy[definitions.get(type)!.primaryKey];
                        if (typeof key !== "string" && typeof key !== "number")
                            return yield* fault("Internal", "Mutation has an invalid primary key.");
                        rememberKey(type, key);
                        staged.set(identity(type, key), { type, key, value: copy });
                    })
                ),
            delete: (type, key) =>
                guard(
                    Effect.flatMap(view(type), () =>
                        Effect.sync(() => {
                            rememberKey(type, key);
                            staged.set(identity(type, key), { type, key });
                        })
                    )
                ),
        };
        const resolved = yield* options
            .execute(local, entry.invocation, { optimistic: entry.optimistic })
            .pipe(
                Effect.onExit((exit) =>
                    Effect.gen(function* () {
                        // Failure keeps previous dependencies and partial reads. A
                        // successful rebase atomically replaces its roots with the new set.
                        if (Exit.isSuccess(exit)) yield* clearActionRoots(tx, entry.invocation.id);
                        for (const [id, row] of keys)
                            yield* tx.put(actionRows, JSON.stringify([entry.invocation.id, id]), {
                                action: entry.invocation.id,
                                ...row,
                                identity: id,
                            });
                        for (const [id, subset] of queries)
                            yield* tx.put(actionQueries, JSON.stringify([entry.invocation.id, id]), {
                                action: entry.invocation.id,
                                subset,
                            });
                    })
                ),
                Effect.ensuring(
                    Effect.sync(() => {
                        active = false;
                    })
                )
            );
        if (entry.optimistic)
            for (const write of staged.values()) {
                const v = views.get(write.type)!;
                yield* retainRowBlobs(tx, write.type, write.key, write.value, "overlay");
                if (write.value === undefined) yield* deleteVisible(tx, v, write.key);
                else yield* putVisible(tx, v, write.key, write.value);
            }
        const invocation = resolved ? { ...entry.invocation, parameters: resolved } : entry.invocation;
        if (options.blobs)
            yield* options.blobs.in(tx).retain(blobOwner(invocation.id), attachmentIds(invocation));
        return {
            ...entry,
            invocation,
            touchedTypes: [...new Set([...staged.values()].map((write) => write.type))],
        };
    });
    const discardFailedTail = Effect.fnUntraced(function* (tx: Transaction) {
        for (const candidate of yield* pendingIn(tx)) {
            // Deliver the rejection to waiting clients after removing executable intent.
            // This uses the same bounded result retention as successful completions.
            yield* tx.put(completed, candidate.invocation.id, {
                ...candidate,
                state: "blocked",
                completedAt: yield* Clock.currentTimeMillis,
                failure: candidate.failure ?? "Conflict",
                failureMessage:
                    candidate.failureMessage ?? "An earlier action failed; this queued action was discarded.",
                failureRetryable: candidate.failureRetryable ?? false,
                failureOutcome:
                    candidate.failureOutcome ?? (candidate.attempts === 0 ? "not-committed" : "unknown"),
            });
            yield* deletePending(tx, candidate.invocation.id);
        }
        // A subsequent demand must obtain confirmed data again after abandoning local intent.
        for (const row of yield* tx.query(coverage)) yield* tx.delete(coverage, row.key);
    });
    const recordFailure = Effect.fnUntraced(function* (
        tx: Transaction,
        entry: PendingAction,
        error: BackendError,
        idempotent: boolean
    ) {
        // A rejected retry does not resolve an earlier dispatch whose reply was lost.
        const ambiguous = entry.failureOutcome === "unknown" || isUnknownActionOutcome(error);
        const requiresAcknowledgement =
            ambiguous && (!idempotent || entry.retryRequiresAcknowledgement === true);
        const retry =
            !requiresAcknowledgement &&
            error.retryable &&
            entry.attempts - (entry.retryFromAttempt ?? 0) <= maxRetries;
        const now = yield* Clock.currentTimeMillis;
        const failed: PendingAction = {
            ...entry,
            state: retry ? "queued" : "blocked",
            retryRequiresAcknowledgement: requiresAcknowledgement,
            failure: error.kind,
            failureMessage: error.message,
            failureIssues: error.issues,
            failureOutcome: ambiguous ? "unknown" : "not-committed",
            failureRetryable: error.retryable,
            nextAttemptAt: retry
                ? now +
                  Math.max(
                      error.retryAfterMs ?? 0,
                      Math.min(
                          60_000,
                          retryDelayMs * 2 ** Math.min(16, entry.attempts - (entry.retryFromAttempt ?? 0) - 1)
                      )
                  )
                : undefined,
        };
        yield* tx.put(outbox, entry.invocation.id, failed);
        // Discard means abandon local intent, not cancel a remote execution.
        if (!retry && options.outbox?.failureStrategy === "discard-all") yield* discardFailedTail(tx);
    });
    const rebase = Effect.fn("Replica.rebase")(function* (tx: Transaction) {
        for (const [type, v] of views) {
            yield* clearRowBlobs(tx, type, "overlay");
            yield* tx.clear(v.overrides);
        }
        let blocked = false;
        for (const entry of yield* pendingIn(tx)) {
            if (blocked || entry.state === "blocked") {
                blocked = true;
                continue;
            }
            const result = yield* Effect.result(boundary(replay(tx, entry)));
            if (result._tag === "Failure") {
                // Failed replay must not erase evidence of an unresolved remote outcome.
                const possibleRemoteOutcome =
                    entry.receipt ||
                    entry.retryRequiresAcknowledgement === true ||
                    entry.state === "sending" ||
                    (entry.attempts > 0 &&
                        entry.failure === "Unavailable" &&
                        entry.failureOutcome !== "not-committed");
                const failed: PendingAction = {
                    ...entry,
                    state: possibleRemoteOutcome ? entry.state : "blocked",
                    failure: possibleRemoteOutcome ? entry.failure : result.failure.kind,
                    failureMessage: result.failure.message,
                    failureRetryable: result.failure.retryable,
                };
                yield* tx.put(outbox, entry.invocation.id, failed);
                if (options.outbox?.failureStrategy === "discard-all") {
                    yield* discardFailedTail(tx);
                    return;
                }
                blocked = true;
            } else yield* tx.put(outbox, entry.invocation.id, result.success);
        }
    });
    yield* boundary(
        tables.transaction((tx) =>
            Effect.gen(function* () {
                yield* tx.put(metadata, "head", yield* position(tx));
                // One designated owner opens this namespace. Query/read leases from
                // a previous incarnation are volatile; pins and outbox roots are separate.
                yield* tx.clear(roots);
                yield* tx.ensureIndex(roots, { name: "objectType", field: field("objectType") });
                yield* tx.ensureIndex(retention, { name: "accessedAt", field: field("accessedAt") });
                yield* tx.ensureIndex(outbox, { name: "sequence", field: field("sequence") });
                if (options.source)
                    yield* tx.ensureIndex(outbox, { name: "includedInBase", field: field("includedInBase") });
                yield* tx.ensureIndex(completed, { name: "completedAt", field: field("completedAt") });
                yield* tx.ensureIndex(journalReceipts, { name: "observedAt", field: field("observedAt") });
                yield* tx.ensureIndex(coverage, { name: "updatedAt", field: field("updatedAt") });
                yield* tx.ensureIndex(coverage, { name: "objectType", field: field("subset", "objectType") });
                yield* tx.ensureIndex(actionRows, { name: "action", field: field("action") });
                yield* tx.ensureIndex(actionRows, { name: "identity", field: field("identity") });
                yield* tx.ensureIndex(actionQueries, { name: "action", field: field("action") });
                yield* tx.ensureIndex(actionQueries, {
                    name: "objectType",
                    field: field("subset", "objectType"),
                });
                for (const [type, v] of views) {
                    yield* tx.ensureIndex(v.base, {
                        name: "primaryKey",
                        field: field(definitions.get(type)!.primaryKey),
                        unique: true,
                    });
                }
                yield* rebase(tx);
            })
        )
    );
    const publicRow = (type: string, object: ObjectValue, key?: Key) =>
        withObjectSources({
            ir: options.ir,
            objectType: definitions.get(type)!,
            object,
            key,
        });
    const publicRows = (type: string, rows: readonly { key: Key; value: ObjectValue }[]) =>
        rows.map((row) => ({ ...row, value: publicRow(type, row.value, row.key) }));
    const readOutside = (confirmed: boolean): OwnedReadTransaction => ({
        get: (type, key) =>
            boundary(
                Effect.andThen(
                    open,
                    tables
                        .read((tx) => reader(tx, confirmed).get(type, key))
                        .pipe(
                            Effect.map((row) => (row === undefined ? undefined : publicRow(type, row, key)))
                        )
                )
            ),
        loadSubset: (type, query) =>
            boundary(
                Effect.andThen(
                    open,
                    tables
                        .read((tx) => reader(tx, confirmed).loadSubset(type, query))
                        .pipe(Effect.map((rows) => publicRows(type, rows)))
                )
            ),
    });
    const loadSubset = (subset: CompiledSubset, reason: ReplicaLoad["reason"]) =>
        diagnostics.load(
            { operation: "loadSubset", reason, subset },
            adapter!
                .loadSubset(objectSubset(subset.objectType, subset.query))
                .pipe(
                    Effect.flatMap((snapshot) =>
                        resolveSubsetSnapshot(
                            options.ir,
                            objectSubset(subset.objectType, subset.query),
                            snapshot,
                            options.context
                        )
                    )
                ),
            (snapshot) => ({
                rows: snapshot.snapshot.rows.length,
                fetchedRows: snapshot.snapshot.fetchedRows,
                pushdown: snapshot.snapshot.pushdown,
                complete: snapshot.snapshot.complete,
            })
        );
    const prepareSnapshot = Effect.fn("Replica.loadSnapshot")(function* (
        subset: CompiledSubset,
        keys?: readonly Key[],
        requireComplete = false,
        reason: ReplicaLoad["reason"] = "demand"
    ) {
        const backend = yield* backendEffect;
        yield* Effect.annotateCurrentSpan("objectType", subset.objectType);
        const generation = coverageGenerations.get(subset.objectType);
        const demandKey = subsetKey(subset);
        const capturedDemand = demands.get(demandKey);
        const demandRevision = capturedDemand?.revision;
        const invalidated = () =>
            coverageGenerations.get(subset.objectType) !== generation ||
            demands.get(demandKey) !== capturedDemand ||
            capturedDemand?.revision !== demandRevision;
        // Local reads apply their own offset. Install the complete leading prefix
        // so a pushed-down offset is not applied twice against a cold cache.
        const request = subset.query ? { ...subset, query: retentionQuery(subset.query) } : subset;
        const resolved = yield* loadSubset(request, reason);
        const snapshot = resolved.snapshot;
        const expanded = options.storeBroaderSubsets === true;
        const storedSubset = expanded ? resolved.fulfilled : subset;
        const storedRows = expanded ? resolved.fulfilledRows : snapshot.rows;
        yield* Effect.annotateCurrentSpan({
            rows: snapshot.rows.length,
            storedRows: storedRows.length,
            reason,
        });
        let repairCandidates = 0;
        let repairRequests = 0;
        let repairRows = 0;
        if (requireComplete && !snapshot.complete)
            return yield* fault("Unavailable", "Action read-back was incomplete.");
        const v = yield* view(subset.objectType);
        const repaired = new Map<Key, ObjectValue | undefined>();
        // A filtered absence is not a deletion: an object can move out of a
        // filter or a top-k window. Watch-only sources must repair those cached
        // candidates by identity before the local query can be evaluated again.
        if (keys) {
            for (const key of keys) repaired.set(key, undefined);
            for (const row of snapshot.rows) {
                if (!keys.includes(row.key))
                    return yield* fault("InvalidResponse", "Action read-back returned an unrequested key.");
                repaired.delete(row.key);
            }
        } else if (!backend.changes && snapshot.complete && !isWholeCollection(storedSubset.query)) {
            const returned = new Set(storedRows.map((row) => row.key));
            const candidates = yield* boundary(tables.query(v.base, { where: storedSubset.query?.where }));
            const missing = candidates.filter((row) => !returned.has(row.key)).map((row) => row.key);
            repairCandidates = missing.length;
            for (let offset = 0; offset < missing.length; offset += 128) {
                const keys = missing.slice(offset, offset + 128);
                repairRequests++;
                const repairResult = yield* loadSubset(
                    {
                        objectType: subset.objectType,
                        query: {
                            where: inArray(field(definitions.get(subset.objectType)!.primaryKey), keys),
                        },
                    },
                    "repair"
                );
                const repair = repairResult.snapshot;
                repairRows += repair.rows.length;
                if (!repair.complete)
                    return yield* fault("Unavailable", "Filtered snapshot repair was incomplete.");
                for (const key of keys) repaired.set(key, undefined);
                for (const row of repair.rows) {
                    if (!keys.includes(row.key))
                        return yield* fault(
                            "InvalidResponse",
                            "Snapshot repair returned an unrequested key."
                        );
                    repaired.set(row.key, row.value);
                }
            }
        }
        yield* Effect.annotateCurrentSpan({ repairCandidates, repairRequests, repairRows });
        const now = yield* Clock.currentTimeMillis;
        return (tx: Transaction) =>
            Effect.gen(function* () {
                let inserted = 0;
                let updated = 0;
                let unchanged = 0;
                let removed = 0;
                let retentionRows = 0;
                const incoming = [
                    ...storedRows,
                    ...[...repaired].flatMap(([key, value]) => (value === undefined ? [] : [{ key, value }])),
                ];
                const properties = encryptedProperties.get(subset.objectType)!;
                // Only an unfiltered complete snapshot can prove arbitrary cached keys were removed.
                if (snapshot.complete && isWholeCollection(storedSubset.query)) {
                    const returned = new Set(incoming.map((row) => row.key));
                    yield* scanDeliveryRows(tx, v.base, {}, (row) =>
                        boundary(
                            Effect.gen(function* () {
                                if (returned.has(row.key)) return;
                                removed++;
                                yield* retainRowBlobs(tx, subset.objectType, row.key, undefined, "base");
                                yield* tx.delete(v.base, row.key);
                                yield* tx.delete(retention, identity(subset.objectType, row.key));
                            })
                        )
                    );
                }
                for (const [key, value] of repaired) {
                    if (value !== undefined) continue;
                    removed++;
                    yield* retainRowBlobs(tx, subset.objectType, key, undefined, "base");
                    yield* tx.delete(v.base, key);
                    yield* tx.delete(retention, identity(subset.objectType, key));
                }
                for (let offset = 0; offset < incoming.length; offset += 128) {
                    const page = incoming.slice(offset, offset + 128);
                    // Incoming snapshots already carry native storage keys. Avoid
                    // reading primary-key index entries to rediscover those keys.
                    const attributes = { objectType: subset.objectType, rows: page.length };
                    const previous = new Map(
                        (yield* tx
                            .getMany(
                                v.base,
                                page.map((row) => row.key)
                            )
                            .pipe(Effect.withSpan("Replica.snapshot.readPrevious", { attributes }))).map(
                            (row) => [row.key, row.value]
                        )
                    );
                    const changed = yield* Effect.gen(function* () {
                        const changed: Row<ObjectValue>[] = [];
                        for (let index = 0; index < page.length; index++) {
                            const row = page[index]!;
                            if (row.value[definitions.get(subset.objectType)!.primaryKey] !== row.key)
                                return yield* fault(
                                    "InvalidResponse",
                                    "Snapshot key does not match its row."
                                );
                            const before = previous.get(row.key);
                            const value = preserveCachedCopies(before, row.value, properties);
                            // Watch invalidations can refresh a whole collection after an
                            // unrelated edit. Preserve unchanged rows, indexes and blob roots.
                            if (before === undefined || v.base.encode(before) !== v.base.encode(value)) {
                                if (before === undefined) inserted++;
                                else updated++;
                                yield* retainRowBlobs(tx, subset.objectType, row.key, value, "base");
                                changed.push({ key: row.key, value });
                            } else unchanged++;
                        }
                        return changed;
                    }).pipe(Effect.withSpan("Replica.snapshot.compare", { attributes }));
                    yield* tx.putMany(v.base, changed).pipe(
                        Effect.withSpan("Replica.snapshot.putBase", {
                            attributes: {
                                objectType: subset.objectType,
                                rows: changed.length,
                                count: page.length,
                            },
                        })
                    );
                    // Returned rows were accessed by the requested snapshot. Identity
                    // repairs also inspect older cached rows outside that result; an
                    // unchanged repair must not renew an unrelated row's cache age.
                    // Changed/inserted repairs keep their existing write-access behavior.
                    const changedKeys = new Set(changed.map((row) => row.key));
                    const accessed = page.filter(
                        (row, index) => offset + index < storedRows.length || changedKeys.has(row.key)
                    );
                    retentionRows += accessed.length;
                    yield* tx
                        .putMany(
                            retention,
                            accessed.map((row) => ({
                                key: identity(subset.objectType, row.key),
                                value: { objectType: subset.objectType, key: row.key, accessedAt: now },
                            }))
                        )
                        .pipe(Effect.withSpan("Replica.snapshot.putRetention", { attributes }));
                }
                if (expanded && subsetKey(storedSubset) !== subsetKey(subset))
                    yield* tx.put(coverage, subsetKey(storedSubset), {
                        subset: storedSubset,
                        complete: snapshot.complete,
                        invalidated: invalidated(),
                        snapshotCursor: snapshot.cursor,
                        barrierCursor:
                            snapshot.cursor !== (yield* position(tx)).cursor ? snapshot.cursor : undefined,
                        rowKeys: storedRows.map((row) => row.key),
                        updatedAt: now,
                    });
                yield* tx.put(coverage, subsetKey(subset), {
                    subset,
                    complete: snapshot.complete,
                    invalidated: invalidated(),
                    snapshotCursor: snapshot.cursor,
                    barrierCursor:
                        snapshot.cursor !== (yield* position(tx)).cursor ? snapshot.cursor : undefined,
                    rowKeys: snapshot.rows.map((row) => row.key),
                    updatedAt: now,
                });
                yield* Effect.annotateCurrentSpan({
                    rows: incoming.length,
                    retentionRows,
                    changed: inserted + updated,
                    inserted,
                    updated,
                    unchanged,
                    // Counts removal commands; a concurrently absent repair key
                    // is deliberately not re-read only for diagnostic accounting.
                    removed,
                    repairCandidates,
                    repairRequests,
                    repairRows,
                });
            }).pipe(
                Effect.withSpan("Replica.snapshot.write", {
                    attributes: { objectType: subset.objectType, reason },
                })
            );
    });
    const installSnapshot = Effect.fn("Replica.installSnapshot")(function* (
        subset: CompiledSubset,
        reason: ReplicaLoad["reason"]
    ) {
        const write = yield* prepareSnapshot(subset, undefined, false, reason);
        yield* boundary(tables.transaction((tx) => Effect.andThen(write(tx), rebase(tx))));
        yield* notify;
    });
    const pullJournal = Effect.fn("Replica.pullChanges")(function* () {
        const backend = yield* backendEffect;
        if (!backend.changes) return;
        for (;;) {
            const before = yield* boundary(tables.read(position));
            const page = yield* diagnostics.load(
                { operation: "pullChanges", reason: "journal" },
                backend.changes.pull({ cursor: before.cursor }),
                (page) => ({
                    commits: page.commits.length,
                    rows: page.commits.reduce((sum, commit) => sum + commit.changes.length, 0),
                })
            );
            if (!page.commits.length && page.cursor === before.cursor && !page.hasMore) return;
            yield* boundary(
                tables.transaction((tx) =>
                    Effect.gen(function* () {
                        const current = yield* position(tx);
                        // Another leader already advanced this source. Never regress its cursor.
                        if (current.cursor !== before.cursor) return;
                        const barriers = (yield* tx.query(coverage)).filter(
                            (row) => row.value.barrierCursor !== undefined
                        );
                        const clearBarrier = (cursor: string | undefined) =>
                            Effect.gen(function* () {
                                for (const row of barriers)
                                    if (row.value.barrierCursor === cursor) {
                                        row.value.barrierCursor = undefined;
                                        yield* tx.put(coverage, row.key, row.value);
                                    }
                            });
                        yield* clearBarrier(current.cursor);
                        for (const commit of page.commits) {
                            for (const change of commit.changes) {
                                // A coordinated newer snapshot already contains this row at the
                                // barrier. Older journal pages must not replace it while catching up.
                                if (
                                    barriers.some(
                                        (row) =>
                                            row.value.barrierCursor !== undefined &&
                                            row.value.subset.objectType === change.objectType &&
                                            (isWholeCollection(row.value.subset.query) ||
                                                row.value.rowKeys?.includes(change.key))
                                    )
                                )
                                    continue;
                                const v = yield* view(change.objectType);
                                if (change.kind === "put") {
                                    if (
                                        change.value[definitions.get(change.objectType)!.primaryKey] !==
                                        change.key
                                    )
                                        return yield* fault(
                                            "InvalidResponse",
                                            "Change key does not match its row."
                                        );
                                    yield* retainRowBlobs(
                                        tx,
                                        change.objectType,
                                        change.key,
                                        change.value,
                                        "base"
                                    );
                                    yield* putBase(tx, change.objectType, change.key, change.value);
                                    yield* tx.put(retention, identity(change.objectType, change.key), {
                                        objectType: change.objectType,
                                        key: change.key,
                                        accessedAt: yield* Clock.currentTimeMillis,
                                    });
                                } else {
                                    yield* retainRowBlobs(
                                        tx,
                                        change.objectType,
                                        change.key,
                                        undefined,
                                        "base"
                                    );
                                    yield* tx.delete(v.base, change.key);
                                    yield* tx.delete(retention, identity(change.objectType, change.key));
                                }
                            }
                            yield* clearBarrier(commit.cursor);
                            if (commit.operationId) {
                                yield* tx.put(
                                    journalReceipts,
                                    JSON.stringify([commit.operationId, commit.cursor]),
                                    {
                                        operationId: commit.operationId,
                                        observedAt: yield* Clock.currentTimeMillis,
                                        outcome: "committed",
                                        cursor: commit.cursor,
                                    }
                                );
                                const entry = yield* tx.get(outbox, commit.operationId);
                                // IDs may be deduplicated within a principal rather than globally.
                                // Only a receipt from our invocation proves which commit is ours.
                                if (entry?.receipt?.cursor === commit.cursor) {
                                    yield* tx.put(completed, commit.operationId, {
                                        ...entry,
                                        completedAt: yield* Clock.currentTimeMillis,
                                        state: "acknowledged",
                                        receipt: { ...entry.receipt, outcome: "committed" },
                                    });
                                    yield* deletePending(tx, commit.operationId);
                                }
                            }
                        }
                        yield* clearBarrier(page.cursor);
                        yield* tx.put(metadata, "head", { ...current, cursor: page.cursor });
                        yield* rebase(tx);
                    })
                )
            );
            yield* notify;
            yield* wakeOutbox;
            if (!page.hasMore) break;
            if (page.cursor === before.cursor)
                return yield* fault("InvalidResponse", "Backend returned a non-advancing change page.");
        }
    });
    const recoverHistory = Effect.fn("Replica.recoverHistory")(function* () {
        const backend = yield* backendEffect;
        const first = options.ir.objectTypes[0];
        if (!first) return;
        // Establish the new starting cursor before loading selected snapshots. Their
        // existing per-subset barriers prevent catch-up from overwriting newer data.
        const anchor = yield* backend.loadSubset(objectSubset(first.name, { limit: 0 }));
        if (!anchor.cursor)
            return yield* fault("NotImplemented", "History recovery requires coordinated snapshot cursors.");
        const requests = new Map<string, CompiledSubset>();
        for (const demand of demands.values()) requests.set(subsetKey(demand.subset), demand.subset);
        for (const [type, store] of views) {
            const keys = (yield* boundary(tables.query(store.base))).map((row) => row.key);
            for (let offset = 0; offset < keys.length; offset += 128) {
                const subset = {
                    objectType: type,
                    query: {
                        where: inArray(
                            field(definitions.get(type)!.primaryKey),
                            keys.slice(offset, offset + 128)
                        ),
                    },
                };
                requests.set(subsetKey(subset), subset);
            }
        }
        const entries = yield* boundary(tables.read(pendingIn));
        for (const entry of entries)
            if (entry.receipt?.outcome === "committed")
                for (const type of entry.touchedTypes) {
                    const subset = { objectType: type };
                    requests.set(subsetKey(subset), subset);
                }
        const writes: Array<Effect.Success<ReturnType<typeof prepareSnapshot>>> = [];
        for (const subset of requests.values())
            writes.push(yield* prepareSnapshot(subset, undefined, true, "refresh"));
        yield* boundary(
            tables.transaction((tx) =>
                Effect.gen(function* () {
                    const previous = yield* position(tx);
                    yield* tx.put(metadata, "head", { ...previous, cursor: anchor.cursor });
                    yield* tx.clear(coverage);
                    for (const write of writes) yield* write(tx);
                    for (const entry of entries)
                        if (entry.receipt?.outcome === "committed") {
                            yield* deletePending(tx, entry.invocation.id);
                            yield* tx.put(completed, entry.invocation.id, {
                                ...entry,
                                completedAt: yield* Clock.currentTimeMillis,
                                state: "acknowledged",
                            });
                        }
                    yield* rebase(tx);
                })
            )
        );
        for (const demand of demands.values()) demand.installed = 0;
        yield* notify;
    });
    const pull = Effect.fnUntraced(function* () {
        if (!adapter?.changes || deliveryActive) return;
        if (syncRetry && syncRetry.at > (yield* Clock.currentTimeMillis)) return yield* syncRetry.error;
        yield* pullJournal().pipe(
            Effect.catch((error) =>
                error.kind === "HistoryExpired" ? recoverHistory() : Effect.fail(error)
            ),
            Effect.tapError((error) =>
                Effect.gen(function* () {
                    if (error.retryable && syncRetry?.error !== error)
                        syncRetry = {
                            error,
                            at:
                                (yield* Clock.currentTimeMillis) +
                                Math.max(stateRetryDelayMs, error.retryAfterMs ?? 0),
                        };
                    yield* service.reportReplicationFailure(error);
                })
            ),
            Effect.tap(() =>
                Effect.gen(function* () {
                    syncRetry = undefined;
                    yield* service.reportReplicationFailure(undefined);
                })
            )
        );
    });
    const confirmReceipt = Effect.fn("Replica.confirmReceipt")(function* (
        head: PendingAction,
        receipt: ActionReceipt
    ) {
        // Persist the remote receipt before read-back. A failed read retries
        // confirmation without resubmitting this non-deduplicating action.
        const targets = new Map<string, Set<Key> | undefined>();
        const readbackTargets =
            receipt.affectedComplete === false
                ? options.ir.objectTypes.map(({ name }) => ({ objectType: name, keys: undefined }))
                : (receipt.affected ??
                  options.ir.objectTypes.map(({ name }) => ({ objectType: name, keys: undefined })));
        for (const target of readbackTargets) {
            if (!target.keys) targets.set(target.objectType, undefined);
            else if (!targets.has(target.objectType) || targets.get(target.objectType))
                targets.set(
                    target.objectType,
                    new Set([...(targets.get(target.objectType) ?? []), ...target.keys])
                );
        }
        const writes: Array<Effect.Success<ReturnType<typeof prepareSnapshot>>> = [];
        for (const [objectType, keys] of targets) {
            if (!keys) writes.push(yield* prepareSnapshot({ objectType }, undefined, true, "receipt"));
            else {
                const primaryKey = definitions.get(objectType)?.primaryKey;
                if (!primaryKey)
                    return yield* fault("InvalidResponse", "Receipt named an unknown object type.");
                const values = [...keys];
                for (let offset = 0; offset < values.length; offset += 128) {
                    const batch = values.slice(offset, offset + 128);
                    writes.push(
                        yield* prepareSnapshot(
                            { objectType, query: { where: inArray(field(primaryKey), batch) } },
                            batch,
                            true,
                            "receipt"
                        )
                    );
                }
            }
        }
        yield* boundary(
            tables.transaction((tx) =>
                Effect.gen(function* () {
                    for (const write of writes) yield* write(tx);
                    yield* deletePending(tx, head.invocation.id);
                    yield* tx.put(completed, head.invocation.id, {
                        ...head,
                        completedAt: yield* Clock.currentTimeMillis,
                        state: "acknowledged",
                        receipt,
                    });
                    yield* rebase(tx);
                })
            )
        );
        yield* notify;
    });
    const bindReceiptBlobs = (tx: Transaction, receipt: ActionReceipt, invocation?: ActionRequest) =>
        Effect.gen(function* () {
            if (!options.blobs) return;
            const mappings = receipt.attachmentIdMappings ?? [];
            for (const mapping of mappings)
                yield* options.blobs.in(tx).bindRemoteId(mapping.localId, mapping.remoteId);
            if (receipt.outcome === "committed" && invocation) {
                const mapped = new Set(mappings.map((mapping) => mapping.localId));
                for (const id of attachmentIds(invocation))
                    if (!mapped.has(id)) yield* options.blobs.in(tx).bindRemoteId(id);
            }
        });
    const collectResults = access(
        tables.transaction((tx) =>
            Effect.gen(function* () {
                const age = options.resultRetentionMs ?? 7 * 24 * 60 * 60 * 1000;
                if (!Number.isFinite(age)) return 0;
                let removed = 0;
                const now = yield* Clock.currentTimeMillis;
                for (const row of yield* tx.query(completed, {
                    where: lte(field("completedAt"), now - age),
                    limit: 100,
                })) {
                    // A child may still be awaiting the result. Its durable session/result window
                    // is finite; never remove the parent's own unresolved outbox.
                    yield* tx.delete(completed, row.key);
                    removed++;
                }
                const protectedHints = (yield* tx.query(outbox)).length;
                for (const row of yield* tx.query(journalReceipts, {
                    where: lte(field("observedAt"), now - age),
                    limit: 100 + protectedHints,
                }))
                    if (!(yield* tx.get(outbox, row.value.operationId))) {
                        yield* tx.delete(journalReceipts, row.key);
                        removed++;
                    }
                for (const row of yield* tx.query(coverage, {
                    where: lte(field("updatedAt"), now - age),
                    // Active coverage may be old when auto-refresh is disabled. Scan past
                    // at most one protected record per active demand to avoid starving eviction.
                    limit: 100 + demands.size,
                }))
                    if (!demands.has(subsetKey(row.value.subset))) {
                        yield* tx.delete(coverage, row.key);
                        removed++;
                    }
                return removed;
            })
        )
    );
    const maintain = Effect.fn("Replica.maintenance")(function* () {
        const clients = yield* service.collectClientGarbage;
        const records = yield* collectResults;
        yield* committedDeliveries.collectGarbage;
        yield* speculativeDeliveries.collectGarbage;
        if (clients || records) yield* notify;
    });
    const saveReceipt = Effect.fn("Replica.saveReceipt")(function* (
        entry: PendingAction,
        receipt: ActionReceipt,
        bindings: boolean
    ) {
        yield* tables.transaction((tx) =>
            Effect.gen(function* () {
                const done = yield* tx.get(completed, entry.invocation.id);
                if (done) yield* tx.put(completed, entry.invocation.id, { ...done, receipt });
                else
                    yield* tx.put(outbox, entry.invocation.id, {
                        ...entry,
                        state: "acknowledged",
                        receipt,
                        failure: undefined,
                        failureMessage: undefined,
                        failureIssues: undefined,
                        failureOutcome: undefined,
                        failureRetryable: undefined,
                        retryRequiresAcknowledgement: false,
                    });
                if (bindings) yield* bindReceiptBlobs(tx, receipt, entry.invocation);
            })
        );
    });
    let recoveredOutbox = false;
    const recoverOutbox = Effect.fnUntraced(function* () {
        if (recoveredOutbox) return;
        yield* open;
        const backend = yield* backendEffect;
        if (!(yield* canSync)) return;
        // Recover only while holding the source leader lease.
        yield* boundary(
            tables.transaction((tx) =>
                Effect.gen(function* () {
                    for (const entry of yield* pendingIn(tx))
                        if (entry.state === "sending") {
                            if (options.outbox?.failureStrategy === "discard-all") {
                                yield* discardFailedTail(tx);
                                return;
                            }
                            yield* tx.put(outbox, entry.invocation.id, {
                                ...entry,
                                state: backend.supportsIdempotency ? "queued" : "blocked",
                                failureOutcome: "unknown",
                                retryRequiresAcknowledgement: !backend.supportsIdempotency,
                                failure: "Unavailable",
                                failureMessage: "Dispatch was interrupted before its result was recorded.",
                            });
                        }
                })
            )
        );
        for (const entry of yield* boundary(tables.read(pendingIn)))
            if (entry.receipt) {
                yield* boundary(
                    tables.transaction((tx) => bindReceiptBlobs(tx, entry.receipt!, entry.invocation))
                );
                yield* options.onReceipt?.(entry.receipt) ?? Effect.void;
            }
        if ((yield* boundary(tables.read(pendingIn))).some((entry) => entry.receipt?.cursor)) yield* pull();
        recoveredOutbox = true;
        // On restart, settle known remote commits before refreshing source snapshots.
        // Otherwise those snapshots can contain our edit while its optimistic
        // mutator is still pending, briefly applying the same edit twice.
        for (;;) {
            const entry = (yield* boundary(tables.read(pendingIn)))[0];
            if (
                !entry?.receipt ||
                entry.receipt.outcome !== "committed" ||
                (entry.nextAttemptAt !== undefined &&
                    entry.nextAttemptAt > (yield* Clock.currentTimeMillis)) ||
                (entry.receipt.cursor && backend.changes && !deliveryActive)
            )
                break;
            yield* confirmReceipt(entry, entry.receipt);
        }
    });
    const drainOutbox = Effect.fn("Replica.drainOutbox", { root: true })(function* (recover = true) {
        yield* open;
        if (replicationError?.recovery === "stop")
            return yield* fault(replicationError.kind, replicationError.message);
        const backend = yield* backendEffect;
        if (!(yield* canSync)) return;
        if (recover) yield* recoverOutbox();
        for (;;) {
            const entries = yield* boundary(tables.read(pendingIn));
            const first = entries[0];
            if (!first || first.state === "blocked") return;
            if (first.nextAttemptAt !== undefined && first.nextAttemptAt > (yield* Clock.currentTimeMillis))
                return;
            let head: PendingAction = first;
            let receipt = head.receipt;
            let newlyReceived = false;
            if (head.state === "acknowledged" && !receipt)
                return yield* fault("Internal", "Acknowledged invocation is missing its receipt.");
            if (!receipt) {
                const claimed = yield* boundary(
                    tables.transaction((tx) =>
                        Effect.gen(function* () {
                            const current = yield* tx.get(outbox, head.invocation.id);
                            if (
                                !current ||
                                current.state !== "queued" ||
                                current.requestIdentity !== head.requestIdentity
                            )
                                return;
                            const sending: PendingAction = {
                                ...current,
                                state: "sending",
                                attempts: current.attempts + 1,
                                failure: undefined,
                                failureOutcome: current.failureOutcome === "unknown" ? "unknown" : undefined,
                            };
                            yield* tx.put(outbox, head.invocation.id, sending);
                            return sending;
                        })
                    )
                );
                if (!claimed) continue;
                head = claimed;
                yield* notify;
                const result = yield* Effect.result(
                    backend.applyAction(head.invocation).pipe(
                        Effect.flatMap((receipt) =>
                            Schema.decodeUnknownEffect(ActionReceiptSchema)(receipt).pipe(
                                Effect.mapError(
                                    (cause) =>
                                        new BackendError({
                                            operation: "applyAction",
                                            kind: "InvalidResponse",
                                            message: "The provider returned an invalid action receipt.",
                                            retryable: false,
                                            actionOutcome: "unknown",
                                            cause: Redacted.make(cause),
                                        })
                                ),
                                Effect.flatMap((receipt) =>
                                    receipt.operationId === head.invocation.id
                                        ? Effect.succeed(receipt)
                                        : Effect.fail(
                                              new BackendError({
                                                  operation: "applyAction",
                                                  kind: "InvalidResponse",
                                                  message:
                                                      "Backend returned a receipt for another operation.",
                                                  retryable: false,
                                                  actionOutcome: "unknown",
                                              })
                                          )
                                )
                            )
                        ),
                        Effect.withSpan("Replica.dispatch")
                    )
                );
                if (result._tag === "Failure") {
                    const error = result.failure;
                    yield* boundary(
                        tables.transaction((tx) =>
                            recordFailure(tx, head, error, backend.supportsIdempotency)
                        )
                    );
                    if (options.outbox?.failureStrategy === "discard-all")
                        yield* boundary(tables.transaction(rebase));
                    if (options.outbox?.failureStrategy === "discard-all") {
                        for (const demand of demands.values()) demand.revision++;
                        yield* wake;
                    }
                    yield* notify;
                    return yield* error;
                }
                receipt = result.success;
                newlyReceived = true;
                // Normally mappings and acknowledgement share one commit. If a local mapping
                // conflicts, preserve the remote evidence separately so recovery never re-invokes.
                yield* boundary(
                    saveReceipt(head, receipt, true).pipe(
                        Effect.catch((error) =>
                            saveReceipt(head, receipt!, false).pipe(Effect.andThen(Effect.fail(error)))
                        )
                    )
                );
                yield* notify;
            }
            if (
                !newlyReceived &&
                options.blobs &&
                (receipt.attachmentIdMappings?.length || attachmentIds(head.invocation).length)
            )
                yield* boundary(
                    tables.transaction((tx) => bindReceiptBlobs(tx, receipt!, head.invocation))
                ).pipe(Effect.withSpan("Replica.bindReceiptAttachments"));
            if (newlyReceived) yield* options.onReceipt?.(receipt) ?? Effect.void;
            if (receipt.cursor && backend.changes && !deliveryActive) {
                yield* pull();
                const remains = yield* boundary(
                    tables.transaction((tx) =>
                        Effect.gen(function* () {
                            const entry = yield* tx.get(outbox, head.invocation.id);
                            if (!entry) return false;
                            const observed = yield* tx.get(
                                journalReceipts,
                                JSON.stringify([head.invocation.id, receipt.cursor])
                            );
                            if (observed?.cursor !== receipt.cursor) return true;
                            yield* deletePending(tx, head.invocation.id);
                            yield* tx.put(completed, head.invocation.id, {
                                ...entry,
                                completedAt: yield* Clock.currentTimeMillis,
                                state: "acknowledged",
                                receipt: { ...receipt, outcome: "committed" },
                            });
                            yield* rebase(tx);
                            return false;
                        })
                    )
                );
                if (remains) return { confirmationPending: true }; // Retry this receipt's catch-up, not submission.
                yield* notify;
            } else {
                yield* confirmReceipt(head, receipt);
            }
        }
    });
    const sync = Effect.fn("Replica.sync", { root: true })(function* (requested?: ReadonlySet<string>) {
        yield* open;
        if (replicationError?.recovery === "stop")
            return yield* fault(replicationError.kind, replicationError.message);
        if (syncRetry && syncRetry.at > (yield* Clock.currentTimeMillis)) return yield* syncRetry.error;
        const backend = yield* backendEffect;
        if (!(yield* canSync)) return;
        // A committed receipt must settle its overlay before a new source snapshot.
        // Recovery belongs to the outbox worker, never to a query acquisition.
        if (
            (yield* boundary(tables.read(pendingIn))).some(
                (entry) => entry.state === "sending" || entry.receipt?.outcome === "committed"
            )
        )
            return;
        yield* Effect.annotateCurrentSpan("stage", "pulling-changes");
        yield* pull();
        yield* Effect.annotateCurrentSpan("stage", "reading-position");
        const now = yield* Clock.currentTimeMillis;

        const covered = Effect.fnUntraced(function* (
            tx: ReadTransaction,
            subset: CompiledSubset,
            records: readonly Row<Coverage>[],
            cursor?: string
        ) {
            const requestedKey = subsetKey(subset);
            const key = primaryKeyLookup(subset.query, definitions.get(subset.objectType)!.primaryKey);
            let present: boolean | undefined;
            for (const { key: recordKey, value: record } of records) {
                if (record.invalidated) continue;
                const live = demands.get(String(recordKey));
                const maxAge =
                    options.demand?.refresh?.maxCoverageAgeMs ??
                    backend.refresh?.(objectSubset(record.subset.objectType, record.subset.query))
                        ?.maxCoverageAgeMs ??
                    60_000;
                const liveWatch =
                    live &&
                    live.watchers > 0 &&
                    live.pollIntervalMs === undefined &&
                    !live.watchFailure &&
                    live.installed === live.revision;
                const maintained = backend.changes
                    ? record.snapshotCursor !== undefined && record.barrierCursor === undefined
                    : liveWatch || now - record.updatedAt < maxAge;
                if (!maintained) continue;
                const proof = (reason: "collection" | "query" | "primary-key") => ({
                    subset: record.subset,
                    proof: {
                        reason,
                        maintainedBy: backend.changes
                            ? ("journal" as const)
                            : live?.pollIntervalMs !== undefined
                              ? ("poll" as const)
                              : liveWatch
                                ? ("watch" as const)
                                : ("snapshot" as const),
                        pollIntervalMs: backend.changes ? undefined : live?.pollIntervalMs,
                    },
                });
                if (record.complete && isWholeCollection(record.subset.query)) return proof("collection");
                if (
                    record.complete &&
                    recordKey === requestedKey &&
                    (!backend.changes || !hasWindow(subset.query) || record.snapshotCursor === cursor)
                )
                    return proof("query");
                if (
                    record.complete &&
                    coversSubset(subset, record.subset) &&
                    (!hasWindow(record.subset.query) || !backend.changes || record.snapshotCursor === cursor)
                )
                    return proof("query");
                if (
                    record.complete &&
                    key !== undefined &&
                    primaryKeyLookup(record.subset.query, definitions.get(subset.objectType)!.primaryKey) ===
                        key
                )
                    return proof("query");
                if (key !== undefined && record.rowKeys?.includes(key)) {
                    present ??=
                        (yield* boundary(tx.get((yield* view(subset.objectType)).base, key))) !== undefined;
                    if (present) return proof("primary-key");
                }
            }
            return undefined;
        });
        type CoverageCheck = {
            demand: NonNullable<ReturnType<typeof demands.get>>;
            generation: symbol | undefined;
            revision: number;
            cached?: Coverage;
            covering?: Effect.Success<ReturnType<typeof covered>>;
        };
        const checks = new Map<string, CoverageCheck>();
        // Read a coherent set of proofs in one snapshot. Separate per-demand
        // transactions let long delivery writes repeatedly jump between these
        // tiny reads while sync holds the publication gate, starving dispatch.
        const readChecks = (objectType?: string) =>
            Effect.suspend(() => {
                // Capture transient fences before the first asynchronous storage
                // operation, not after reading records that may already be stale.
                const selected = [...demands]
                    .filter(
                        ([, demand]) =>
                            !deliveryActive &&
                            (objectType === undefined || demand.subset.objectType === objectType)
                    )
                    .map(([key, demand]) => ({
                        key,
                        demand,
                        revision: demand.revision,
                        generation: coverageGenerations.get(demand.subset.objectType),
                    }));
                return boundary(
                    tables
                        .read((tx) =>
                            Effect.gen(function* () {
                                const head = yield* position(tx);
                                const byType = new Map<string, readonly Row<Coverage>[]>();
                                yield* Effect.annotateCurrentSpan("demands", selected.length);
                                for (const type of new Set(
                                    selected.map(({ demand }) => demand.subset.objectType)
                                ))
                                    byType.set(
                                        type,
                                        yield* tx.query(coverage, {
                                            where: eq(field("subset", "objectType"), type),
                                        })
                                    );
                                yield* Effect.forEach(
                                    selected,
                                    ({ key, demand, revision, generation }) =>
                                        Effect.gen(function* () {
                                            const records = byType.get(demand.subset.objectType)!;
                                            checks.set(key, {
                                                demand,
                                                generation,
                                                revision,
                                                cached: records.find((row) => row.key === key)?.value,
                                                covering: yield* covered(
                                                    tx,
                                                    demand.subset,
                                                    records,
                                                    head.cursor
                                                ),
                                            });
                                        }),
                                    { concurrency: 128, discard: true }
                                );
                            })
                        )
                        .pipe(Effect.withSpan("Replica.checkCoverage"))
                );
            });
        yield* Effect.annotateCurrentSpan("stage", "checking-coverage");
        yield* readChecks();
        // Snapshot refresh follows journal catch-up, so historical commits cannot replace newer snapshots.
        let demandFailure: BackendError | undefined;
        let coverageChanged = false;
        type Demand = typeof demands extends Map<string, infer D> ? D : never;
        type Covering = NonNullable<ReturnType<typeof checks.get>>["covering"];
        const applyCoverage = (demand: Demand, covering: NonNullable<Covering>) => {
            coverageChanged ||=
                demand.installed !== demand.revision ||
                !demand.coveredBy ||
                subsetKey(demand.coveredBy) !== subsetKey(covering.subset);
            demand.installed = demand.revision;
            demand.loadFailure = undefined;
            demand.coveredBy = covering.subset;
            demand.coverageProof = covering.proof;
        };
        // Loads are grouped by object type: different types load concurrently,
        // while one type's loads stay ordered so a completed superset can still
        // satisfy the next demand of that type without another fetch.
        const pendingLoads = new Map<
            string,
            Array<{ readonly demand: Demand; readonly relevant: boolean }>
        >();
        for (const demand of demands.values()) {
            if (deliveryActive) continue;
            const relevant = requested === undefined || requested.has(subsetKey(demand.subset));
            if (demand.loadFailure?.revision === demand.revision && !demand.loadFailure.error.retryable) {
                if (relevant) demandFailure ??= demand.loadFailure.error;
                continue;
            }
            yield* Effect.annotateCurrentSpan({
                stage: "checking-coverage",
                objectType: demand.subset.objectType,
            });
            const key = subsetKey(demand.subset);
            let check = checks.get(key);
            while (
                check &&
                (check.demand !== demand ||
                    check.revision !== demand.revision ||
                    check.generation !== coverageGenerations.get(demand.subset.objectType))
            ) {
                if (demands.get(key) !== demand) {
                    check = undefined;
                    break;
                }
                yield* readChecks(demand.subset.objectType);
                check = checks.get(key);
            }
            if (!check) continue; // A concurrently acquired demand has its own queued check.
            const cached = check.cached;
            if (check.covering) {
                applyCoverage(demand, check.covering);
                continue;
            }
            demand.coveredBy = undefined;
            demand.coverageProof = undefined;
            if (
                demand.watchers > 0 &&
                demand.pollIntervalMs === undefined &&
                !demand.watchFailure &&
                cached?.complete &&
                !cached.invalidated &&
                demand.installed === demand.revision
            )
                continue;
            // A watch must be registered before a new snapshot starts. The
            // background pass skips opening watches rather than holding the
            // publication gate across network acquisition.
            if (demand.watchReady && !(yield* Deferred.isDone(demand.watchReady))) continue;
            const group = pendingLoads.get(demand.subset.objectType);
            if (group) group.push({ demand, relevant });
            else pendingLoads.set(demand.subset.objectType, [{ demand, relevant }]);
        }
        const loadDemand = Effect.fnUntraced(function* (demand: Demand, relevant: boolean) {
            const revision = demand.revision;
            const authenticationAtLoad = authenticationGeneration;
            // Demand refresh belongs to the aggregate lease, not its first UI caller.
            // Releasing the last consumer cancels its IO without interrupting outbox work.
            const installed = yield* Effect.result(
                Effect.raceFirst(
                    installSnapshot(demand.subset, demand.installed === 0 ? "demand" : "refresh").pipe(
                        Effect.as(true)
                    ),
                    Deferred.await(demand.released).pipe(Effect.as(false))
                )
            );
            if (installed._tag === "Failure") {
                if (
                    installed.failure.kind === "Unauthenticated" &&
                    authenticationGeneration > authenticationAtLoad &&
                    connection?.state.status === "active"
                ) {
                    demand.loadFailure = undefined;
                    if (demand.revision === revision) demand.revision++;
                    yield* wakeState;
                } else demand.loadFailure = { revision, error: installed.failure };
                if (relevant) demandFailure ??= installed.failure;
                return false;
            }
            if (!installed.success) return false;
            coverageChanged = true;
            demand.installed = revision;
            demand.loadFailure = undefined;
            // A newly loaded superset can satisfy later demands of this type.
            yield* readChecks(demand.subset.objectType);
            return true;
        });
        yield* Effect.annotateCurrentSpan("stage", "loading-subset");
        yield* Effect.forEach(
            pendingLoads.values(),
            Effect.fnUntraced(function* (group) {
                let loaded = false;
                for (const { demand, relevant } of group) {
                    const key = subsetKey(demand.subset);
                    if (demands.get(key) !== demand) continue;
                    if (loaded) {
                        const check = checks.get(key);
                        if (
                            check?.demand === demand &&
                            check.revision === demand.revision &&
                            check.covering
                        ) {
                            applyCoverage(demand, check.covering);
                            continue;
                        }
                    }
                    loaded = (yield* loadDemand(demand, relevant)) || loaded;
                }
            }),
            { concurrency: "unbounded", discard: true }
        );
        // Snapshot writes notify before this in-memory readiness bookkeeping.
        // A child may have captured those rows with incomplete coverage already;
        // publish the readiness transition even when no additional rows changed.
        if (coverageChanged) yield* notify;
        if (demandFailure) return yield* demandFailure;
    });
    const parentStateIn = Effect.fnUntraced(function* (tx: ReadTransaction) {
        const head = yield* tx.get(imported, "head");
        if (!head) return;
        const objects: Array<ReplicaStateSnapshot["objects"][number]> = [];
        for (const [objectType, v] of views)
            objects.push({
                objectType,
                base: yield* tx.query(v.base),
                overrides: v.inherited ? yield* tx.query(v.inherited) : [],
            });
        const { digest: _digest, resident: _resident, ...publicHead } = head;
        return {
            ...publicHead,
            objects,
            pending: (yield* tx.query(importedPending)).map((row) => row.value),
            completed: (yield* tx.query(importedCompleted)).map((row) => row.value),
        };
    });
    const snapshotStateIn = Effect.fnUntraced(function* (tx: ReadTransaction, selected?: ClientView) {
        const head = (yield* tx.get(stateHead, "head"))!;
        const parent = yield* tx.get(imported, "head");
        const objects: Array<ReplicaStateSnapshot["objects"][number]> = [];
        for (const subset of selected?.selection.subsets ?? []) {
            yield* view(subset.objectType);
            yield* Effect.try({
                try: () => evaluateQuery([], subset.query ?? {}),
                catch: (cause) => fault("InvalidRequest", "Invalid selected query.", cause),
            });
        }
        for (const [objectType, v] of views) {
            const baseline = v.base;
            if (selected) {
                const visible = new Map<Key, ObjectValue>();
                for (const subset of selected.selection.subsets)
                    if (subset.objectType === objectType)
                        for (const row of yield* loadVisible(tx, v, subset.query))
                            visible.set(row.key, row.value);
                const base: Array<Row<ObjectValue>> = [];
                const overrides: Array<Row<Override<ObjectValue>>> = [];
                for (const [key, value] of visible) {
                    const original = yield* tx.get(baseline, key);
                    if (original !== undefined) base.push({ key, value: original });
                    if (original === undefined || v.base.encode(original) !== v.base.encode(value))
                        overrides.push({ key, value: { deleted: false, value } });
                }
                objects.push({ objectType, base, overrides });
                continue;
            }
            const base = yield* tx.query(baseline);
            let overrides: readonly Row<Override<ObjectValue>>[];
            if (!parent) overrides = yield* tx.query(v.overrides);
            else {
                const visible = new Map((yield* loadVisible(tx, v)).map((row) => [row.key, row.value]));
                const original = new Map(base.map((row) => [row.key, row.value]));
                overrides = [
                    ...base
                        .filter((row) => !visible.has(row.key))
                        .map((row) => ({ key: row.key, value: { deleted: true as const } })),
                    ...[...visible]
                        .filter(
                            ([key, value]) =>
                                !original.has(key) ||
                                v.base.encode(original.get(key)!) !== v.base.encode(value)
                        )
                        .map(([key, value]) => ({ key, value: { deleted: false as const, value } })),
                ];
            }
            objects.push({ objectType, base, overrides });
        }
        const actions = Effect.fnUntraced(function* (
            table: import("@party-stack/ontology-storage/tables").Table<PendingAction>,
            pending = false
        ) {
            if (!selected || (pending && selected.selection.inspectActions))
                return (yield* tx.query(table)).map((row) => row.value);
            const entries: PendingAction[] = [];
            for (const id of selected.selection.actionIds) {
                const entry = yield* tx.get(table, id);
                if (entry) entries.push(entry);
            }
            return entries;
        });
        const pending = new Map(
            (parent ? yield* actions(importedPending, true) : []).map((entry) => [entry.invocation.id, entry])
        );
        for (const entry of yield* actions(outbox, true))
            if (!(entry as LocalAction).includedInBase) pending.set(entry.invocation.id, publicAction(entry));
        const done = new Map(
            (parent ? yield* actions(importedCompleted) : []).map((entry) => [entry.invocation.id, entry])
        );
        for (const entry of yield* actions(completed)) done.set(entry.invocation.id, entry);
        return {
            ...head,
            definition: signature,
            ...(selected ? { view: { generation: selected.generation } } : {}),
            objects,
            pending: [...pending.values()],
            completed: [...done.values()],
        };
    });
    const enqueueIn = Effect.fnUntraced(function* (
        tx: Transaction,
        invocation: ActionRequest,
        settings?: { optimistic?: boolean }
    ) {
        const requestIdentity = Table.make<ActionRequest>({ name: "identity" }).encode(invocation);
        const existing = (yield* tx.get(outbox, invocation.id)) ?? (yield* tx.get(completed, invocation.id));
        if (existing) {
            if (existing.requestIdentity !== requestIdentity)
                return yield* fault("Conflict", "Invocation identity was reused.");
            return publicAction(existing);
        }
        const observed =
            (yield* tx.get(importedPending, invocation.id)) ??
            (yield* tx.get(importedCompleted, invocation.id));
        if (observed) {
            const resolvedIdentity = Table.make<ActionRequest>({
                name: "identity",
            }).encode(observed.invocation);
            if (observed.requestIdentity !== requestIdentity && resolvedIdentity !== requestIdentity)
                return yield* fault("Conflict", "Invocation identity was reused.");
            return observed;
        }
        const state = yield* position(tx);
        if (!Number.isSafeInteger(state.sequence + 1))
            return yield* fault("Unavailable", "Replica sequence exhausted.");
        const proposed: PendingAction = {
            invocation: {
                ...invocation,
                replay: invocation.replay ?? {
                    now: new Date(yield* Clock.currentTimeMillis).toISOString(),
                    seed: invocation.id,
                },
            },
            requestIdentity,
            createdAt: yield* Clock.currentTimeMillis,
            sequence: state.sequence + 1,
            state: "queued",
            optimistic: settings?.optimistic ?? true,
            attempts: 0,
            touchedTypes: [],
        };
        const resolved = yield* replay(tx, proposed);
        yield* tx.put(outbox, invocation.id, resolved);
        yield* tx.put(metadata, "head", { ...state, sequence: resolved.sequence });
        return resolved;
    });
    const runStateSync = (requested?: ReadonlySet<string>) =>
        gate
            .withPermit(diagnostics.sync(sync(requested)))
            .pipe(
                Effect.withSpan("Replica.stateSyncWork", { attributes: { activity: "request" } }),
                Effect.provideService(Tracer.Tracer, deliveryTracer)
            );
    // Background sync waits for authentication silently, but an explicit checkpoint
    // that skipped the backend must not report success.
    const requireAuthentication = Effect.suspend(() => {
        const status = connection?.state.status;
        if (status !== "needs-auth" && status !== "inactive") return Effect.void;
        return Effect.fail(
            new BackendError({
                operation: "replica.syncOnce",
                kind: "Unauthenticated",
                retryable: false,
                message:
                    status === "needs-auth"
                        ? "The connection must sign in again before it can sync."
                        : "The connection is signed out.",
            })
        );
    });
    const syncOnce = Effect.andThen(
        Effect.andThen(requireAuthentication, maintain()),
        options.source
            ? Effect.suspend(() => service.syncParent(options.source!))
            : gate
                  .withPermit(
                      diagnostics.sync(
                          Effect.gen(function* () {
                              yield* recoverOutbox();
                              const state = yield* Effect.result(sync());
                              yield* drainOutbox(false);
                              if (state._tag === "Failure") return yield* state.failure;
                          })
                      )
                  )
                  .pipe(
                      Effect.andThen(
                          Effect.suspend(() => (openingWatches().length ? syncReady() : Effect.void))
                      )
                  )
    );
    const ownSourceId = (yield* boundary(tables.get(stateHead, "head")))!.sourceId;
    const clients = clientRegistry(options.namespace, ownSourceId, options.clients);
    yield* boundary(options.tables.transaction(clients.initialize));
    let parentSession: ClientLease | undefined;
    const sessionGate = yield* Semaphore.make(1);
    const sessionFor = Effect.fnUntraced(function* (source: OntologySource) {
        if (!options.source || source.sourceId !== sourceId)
            return yield* fault(
                "SourceMismatch",
                "Protocol source identity differs from this Replica's binding."
            );
        if (parentSession) return parentSession;
        const state = yield* access(tables.read(position));
        const lease = yield* source.openClient(state.parentClient).pipe(
            Effect.catch((error) => {
                if (error.kind !== "SessionExpired" && error.kind !== "SessionReplaced")
                    return Effect.fail(error);
                return Effect.gen(function* () {
                    const renewed = yield* source.openClient();
                    yield* access(
                        tables.transaction((tx) =>
                            Effect.gen(function* () {
                                for (const row of yield* pendingIn(tx))
                                    if (row.submission) {
                                        const unknown =
                                            row.state === "sending" ||
                                            (row.attempts > 0 && row.failureOutcome !== "not-committed");
                                        yield* tx.put(outbox, row.invocation.id, {
                                            ...row,
                                            submission: undefined,
                                            state: unknown ? "blocked" : row.state,
                                            retryRequiresAcknowledgement:
                                                unknown || row.retryRequiresAcknowledgement,
                                            failure: unknown ? "SessionExpired" : row.failure,
                                            failureOutcome: unknown ? "unknown" : row.failureOutcome,
                                            failureMessage: unknown
                                                ? "The previous parent session expired before this action's outcome was resolved."
                                                : row.failureMessage,
                                        });
                                    }
                                const current = yield* position(tx);
                                yield* tx.put(metadata, "head", {
                                    ...current,
                                    parentClient: undefined,
                                    parentSubmissionSequence: 0,
                                    parentViewIdentity: undefined,
                                });
                            })
                        )
                    );
                    return renewed;
                });
            })
        );
        yield* access(
            tables.transaction((tx) =>
                Effect.gen(function* () {
                    const current = yield* position(tx);
                    yield* tx.put(metadata, "head", {
                        ...current,
                        parentClient: lease.client,
                        parentSubmissionSequence: Math.max(
                            state.parentClient?.clientId === lease.client.clientId
                                ? (current.parentSubmissionSequence ?? 0)
                                : 0,
                            lease.acceptedThrough
                        ),
                        parentViewGeneration: Math.max(
                            current.parentViewGeneration ?? 0,
                            lease.viewGeneration ?? 0
                        ),
                    });
                })
            )
        );
        parentSession = lease;
        return lease;
    }, sessionGate.withPermits(1));
    const requestedView = Effect.fnUntraced(function* (): Effect.fn.Return<ClientView, BackendError> {
        return yield* access(
            options.tables.transaction((tx) =>
                Effect.gen(function* () {
                    const subsets = new Map<string, CompiledSubset>();
                    const include = (subset: CompiledSubset) => {
                        const requested =
                            deliveryActive && isWholeCollection(subset.query)
                                ? { objectType: subset.objectType, query: {} }
                                : canonicalSubset(subset);
                        subsets.set(subsetKey(requested), requested);
                    };
                    for (const row of yield* tx.query(roots, { where: eq(field("owner"), rootOwner) }))
                        if (row.value.kind === "remote")
                            include({
                                objectType: row.value.objectType,
                                query: retentionQuery(row.value.query),
                            });
                    const pinned = new Map<string, Key[]>();
                    const flushPins = (objectType: string) => {
                        const keys = pinned.get(objectType)!;
                        if (keys.length)
                            include({
                                objectType,
                                query: {
                                    where: inArray(field(definitions.get(objectType)!.primaryKey), [...keys]),
                                },
                            });
                        keys.length = 0;
                    };
                    yield* scanDeliveryRows(tx, pins, {}, (row) =>
                        Effect.sync(() => {
                            const keys = pinned.get(row.value.objectType) ?? [];
                            pinned.set(row.value.objectType, keys);
                            keys.push(row.value.key);
                            if (keys.length === 128) flushPins(row.value.objectType);
                        })
                    );
                    for (const objectType of pinned.keys()) flushPins(objectType);
                    const pending = [
                        ...(yield* pendingIn(tx)),
                        ...(yield* acceptedIn(tx)).map((row) => row.value),
                    ];
                    for (const entry of pending) {
                        for (const row of yield* tx.query(actionRows, {
                            where: eq(field("action"), entry.invocation.id),
                        }))
                            include({
                                objectType: row.value.objectType,
                                query: {
                                    where: eq(
                                        field(definitions.get(row.value.objectType)!.primaryKey),
                                        row.value.key
                                    ),
                                },
                            });
                        for (const row of yield* tx.query(actionQueries, {
                            where: eq(field("action"), entry.invocation.id),
                        }))
                            include({ ...row.value.subset, query: retentionQuery(row.value.subset.query) });
                    }
                    const actionIds = new Set(pending.map((entry) => entry.invocation.id));
                    let inspectActions = false;
                    for (const ids of actionInterests.values()) {
                        if (ids === undefined) inspectActions = true;
                        else for (const id of ids) actionIds.add(id);
                    }
                    // An inspector follows outcomes of pending actions it has seen,
                    // without importing the parent's unrelated retained history.
                    if (options.source && inspectActions)
                        for (const row of yield* tx.query(importedPending))
                            actionIds.add(row.value.invocation.id);
                    const completeTypes = new Set(
                        deliveryActive
                            ? [...subsets.values()]
                                  .filter((subset) => isWholeCollection(subset.query))
                                  .map((subset) => subset.objectType)
                            : []
                    );
                    const selection = {
                        subsets: [...subsets.entries()]
                            .filter(
                                ([, subset]) =>
                                    isWholeCollection(subset.query) || !completeTypes.has(subset.objectType)
                            )
                            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                            .map(([, subset]) => subset),
                        // Committed delivery contains rows only. Local action inspection must not
                        // replace its generation or rewrite metadata on a retained frame.
                        actionIds: options.source ? [...actionIds].sort() : [],
                        ...(options.source && inspectActions ? { inspectActions: true } : {}),
                    };
                    const identity = Table.make({ name: "view-identity" }).encode(selection);
                    const current = yield* position(tx);
                    const generation =
                        (current.parentViewGeneration ?? 0) +
                        (current.parentViewIdentity === identity ? 0 : 1);
                    if (!Number.isSafeInteger(generation) || generation < 1)
                        return yield* fault("Internal", "Selected view generation exhausted.");
                    if (current.parentViewIdentity !== identity)
                        yield* tx.put(metadata, "head", {
                            ...current,
                            parentViewGeneration: generation,
                            parentViewIdentity: identity,
                        });
                    return { generation, selection };
                })
            )
        );
    });
    const adoptClientState = Effect.fnUntraced(function* (source: OntologySource, batch: ClientState) {
        const session = yield* sessionFor(source);
        if (
            batch.client.client.clientId !== session.client.clientId ||
            batch.client.connectionId !== session.connectionId
        )
            return yield* fault("Conflict", "Received state belongs to a different client connection.");
        const current = yield* access(tables.read(position));
        if ((batch.state.view?.generation ?? 0) !== (current.parentViewGeneration ?? 0)) return;
        const selection = current.parentViewIdentity
            ? Table.make<{ actionIds: readonly string[] }>({ name: "view-identity" }).decode(
                  current.parentViewIdentity
              )
            : undefined;
        yield* service.receiveParentState(batch.state, selection?.actionIds, batch.coverage);
        yield* source.acknowledge(
            session,
            batch.state.revision,
            batch.client.deliveredThrough,
            batch.state.view?.generation
        );
    });
    const settleParentActions = Effect.fnUntraced(function* (
        tx: Transaction,
        pending: readonly PendingAction[],
        results: readonly PendingAction[],
        requestedActionIds?: readonly string[]
    ) {
        const terminal = new Map(results.map((entry) => [entry.invocation.id, entry]));
        // The parent's result window may expire after a mapping failure. A
        // locally saved committed receipt still proves the action outcome.
        for (const { value: entry } of yield* tx.query(outbox))
            if (entry.receipt?.outcome === "committed" && !terminal.has(entry.invocation.id))
                terminal.set(entry.invocation.id, publicAction(entry));
        const known = new Map(
            [...pending, ...terminal.values()].map((entry) => [entry.invocation.id, entry])
        );
        for (const entry of yield* pendingIn(tx)) {
            const observed = known.get(entry.invocation.id);
            if (!observed) continue;
            const identity = Table.make<ActionRequest>({ name: "invocation" }).encode(entry.invocation);
            if (observed.requestIdentity !== entry.requestIdentity && observed.requestIdentity !== identity)
                return yield* fault("Conflict", "Parent invocation identity differs from the local action.");
            yield* tx.put(outbox, entry.invocation.id, { ...entry, includedInBase: true });
        }
        for (const row of yield* acceptedIn(tx)) {
            const observed = pending.find((entry) => entry.invocation.id === row.key);
            if (
                observed &&
                Table.make({ name: "invocation" }).encode(observed.invocation) !==
                    Table.make({ name: "invocation" }).encode(row.value.invocation)
            )
                yield* tx.put(outbox, row.key, {
                    ...row.value,
                    invocation: observed.invocation,
                    requestIdentity: observed.requestIdentity,
                });
        }
        for (const entry of terminal.values()) {
            const local = yield* tx.get(outbox, entry.invocation.id);
            if (local?.includedInBase && (entry.receipt || entry.failure)) {
                if (entry.receipt) yield* bindReceiptBlobs(tx, entry.receipt, local.invocation);
                yield* tx.put(completed, entry.invocation.id, {
                    ...entry,
                    requestIdentity:
                        Table.make({ name: "invocation" }).encode(entry.invocation) ===
                        Table.make({ name: "invocation" }).encode(local.invocation)
                            ? local.requestIdentity
                            : entry.requestIdentity,
                    sequence: local.sequence,
                    completedAt: yield* Clock.currentTimeMillis,
                    state: entry.receipt ? "acknowledged" : "blocked",
                    receipt: entry.receipt,
                });
                yield* deletePending(tx, entry.invocation.id);
            } else if (
                !local &&
                requestedActionIds?.includes(entry.invocation.id) &&
                (entry.receipt || entry.failure) &&
                !(yield* tx.get(completed, entry.invocation.id))
            ) {
                // Keep an observed result locally after its upstream interest ends.
                // It uses the ordinary receipt retention/GC, not another result cache.
                yield* tx.put(completed, entry.invocation.id, {
                    ...entry,
                    completedAt: yield* Clock.currentTimeMillis,
                    state: entry.receipt ? "acknowledged" : "blocked",
                });
            }
        }
        if (requestedActionIds)
            for (const row of yield* acceptedIn(tx)) {
                if (!requestedActionIds.includes(row.key as string) || known.has(row.key as string)) continue;
                yield* tx.put(outbox, row.key, {
                    ...publicAction(row.value),
                    state: "blocked",
                    retryRequiresAcknowledgement: true,
                    optimistic: false,
                    failure: "ResultExpired",
                    failureOutcome: "unknown",
                    failureRetryable: false,
                    failureMessage:
                        "The parent no longer retains this accepted action's result. Reconcile, retry explicitly, or discard it.",
                });
            }
    });
    const captureSelection = Effect.fnUntraced(function* (
        storage: Transaction,
        selected: ClientView,
        emit: (record: DeliveryRecord) => Effect.Effect<void, BackendError>,
        speculative: boolean
    ) {
        // Delivery session bookkeeping deliberately uses raw storage. Apply
        // object-query translation here too, without publishing extra revisions.
        const tx = primaryKeyQueries(storage, primaryKeys);
        // Several demanded subsets can select the same object. Each row has one
        // base/visible value within this transaction, independent of its query.
        const emittedRows = new Set<string>();
        // This proof belongs to this transaction, including every query page and
        // overlapping subset. Any overlay row (including a tombstone) prevents it.
        const baseOnlyTypes = new Map<string, boolean>();
        for (const subset of selected.selection.subsets) {
            const v = yield* view(subset.objectType);
            let baseOnly = !speculative;
            if (speculative) {
                let empty = baseOnlyTypes.get(subset.objectType);
                if (empty === undefined) {
                    empty = yield* boundary(
                        Effect.gen(function* () {
                            if ((yield* tx.query(v.overrides, { limit: 1 })).length) return false;
                            return !v.inherited || (yield* tx.query(v.inherited, { limit: 1 })).length === 0;
                        })
                    );
                    baseOnlyTypes.set(subset.objectType, empty);
                }
                baseOnly = empty;
            }
            let bases = new Map<Key, ObjectValue>();
            yield* scanSelectedRows(
                (query) =>
                    boundary(
                        Effect.gen(function* () {
                            const rows = yield* baseOnly
                                ? tx.query(v.base, query)
                                : loadVisible(tx, v, query);
                            // Selected rows already carry their native storage keys. Read
                            // their baselines directly in one bounded batch, without an
                            // index lookup for each primary-key value.
                            bases = new Map();
                            if (!baseOnly) {
                                const keys = rows
                                    .filter((row) => !emittedRows.has(identity(subset.objectType, row.key)))
                                    .map((row) => row.key);
                                if (keys.length)
                                    for (const row of yield* tx.getMany(v.base, keys))
                                        bases.set(row.key, row.value);
                            }
                            return rows;
                        })
                    ),
                subset.query,
                (row) =>
                    Effect.gen(function* () {
                        const key = identity(subset.objectType, row.key);
                        if (emittedRows.has(key)) return;
                        emittedRows.add(key);
                        const base = baseOnly ? row.value : bases.get(row.key);
                        if (base !== undefined)
                            yield* emit({
                                kind: "base",
                                objectType: subset.objectType,
                                key: row.key,
                                value: base,
                            });
                        if (
                            !baseOnly &&
                            (base === undefined || v.base.encode(base) !== v.base.encode(row.value))
                        )
                            yield* emit({
                                kind: "override",
                                objectType: subset.objectType,
                                key: row.key,
                                value: { deleted: false, value: row.value },
                            });
                    })
            );
        }
        if (speculative) {
            const send = (table: Table<PendingAction>, kind: "pending" | "completed", own = false) =>
                selected.selection.inspectActions && kind === "pending"
                    ? boundary(
                          scanDeliveryRows(tx, table, {}, (row) =>
                              own && (row.value as LocalAction).includedInBase
                                  ? Effect.void
                                  : emit({
                                        kind,
                                        id: row.value.invocation.id,
                                        value: publicAction(row.value),
                                    })
                          )
                      )
                    : Effect.forEach(
                          selected.selection.actionIds,
                          (id) =>
                              Effect.gen(function* () {
                                  const entry = yield* boundary(tx.get(table, id));
                                  if (entry && !(own && (entry as LocalAction).includedInBase))
                                      yield* emit({ kind, id, value: publicAction(entry) });
                              }),
                          { discard: true }
                      );
            yield* send(importedPending, "pending");
            yield* send(outbox, "pending", true);
            yield* send(importedCompleted, "completed");
            yield* send(completed, "completed");
        }
        const coverageEntries: DeliveryMetadata["coverage"][number][] = [];
        for (const subset of selected.selection.subsets) {
            const proof = yield* coverageFor(tx, subset);
            const cached = proof?.complete ? proof : yield* cachedCoverageFor(tx, subset);
            coverageEntries.push({
                subset,
                complete: proof?.complete === true && !proof.invalidated,
                ...(cached ? { cached: true } : {}),
            });
        }
        return {
            sourceId: speculative ? ownSourceId : sourceId,
            schemaHash,
            generation: selected.generation,
            revision: (yield* tx.get(stateHead, "head"))!.revision,
            cursor: (yield* position(tx)).cursor,
            coverage: coverageEntries,
        } satisfies DeliveryMetadata;
    });
    const checkDelivery = Effect.fnUntraced(function* (tx: Transaction, meta: DeliveryMetadata) {
        if (meta.sourceId !== sourceId) return yield* fault("SourceMismatch", "Delivery source changed.");
        if (meta.schemaHash !== schemaHash)
            return yield* fault("SchemaMismatch", "Delivery definition changed.");
        if (
            options.source &&
            (!meta.client ||
                !parentSession ||
                meta.client.client.clientId !== parentSession.client.clientId ||
                meta.client.client.resumeKey !== parentSession.client.resumeKey ||
                meta.client.client.sourceId !== sourceId)
        )
            return yield* fault("InvalidResponse", "Delivery belongs to a different client session.");
        const current = yield* position(tx);
        const generation = options.source
            ? meta.generation
            : ((yield* deliveryGeneration) ?? meta.generation);
        if (current.parentViewGeneration === generation) return true;
        if (
            options.source &&
            generation >= 1 &&
            generation < (current.parentViewGeneration ?? 0) &&
            current.parentViewIdentity
        ) {
            const selected = Table.make<ClientView["selection"]>({ name: "view-identity" }).decode(
                current.parentViewIdentity
            );
            const rows = (subsets: readonly CompiledSubset[]) =>
                JSON.stringify([...new Set(subsets.map(subsetKey))].sort());
            if (rows(selected.subsets) === rows(meta.coverage.map((entry) => entry.subset))) {
                const importedHead = yield* tx.get(imported, "head");
                if (importedHead && importedHead.revision > meta.revision)
                    return yield* fault("HistoryExpired", "A newer parent state replaced this target.");
                return false;
            }
        }
        return yield* fault("ViewReplaced", "Delivery selection was superseded.");
    });
    const preserveReceipt = Effect.fnUntraced(function* (tx: Transaction, entry: PendingAction) {
        const local = yield* tx.get(outbox, entry.invocation.id);
        if (!local || !entry.receipt) return;
        if (
            entry.receipt.operationId !== local.invocation.id ||
            (entry.requestIdentity !== local.requestIdentity &&
                entry.requestIdentity !==
                    Table.make<ActionRequest>({ name: "invocation" }).encode(local.invocation))
        )
            return yield* fault("Conflict", "Parent result differs from the local action.");
        yield* tx.put(outbox, entry.invocation.id, {
            ...local,
            receipt: entry.receipt,
            state: "acknowledged",
        });
    });
    // The installed upstream membership is separate from the wider local cache.
    // A later query can revisit a cached row which left the upstream view before
    // it was deleted. Membership lets view repair remove that stale copy even
    // when neither the previous nor the new upstream target includes it.
    const deliveryRows = Table.make<boolean>({ name: name("delivery-seen") });
    const receiver = yield* makeDeliveryReceiver({
        tables,
        namespace: name("upstream"),
        beforeApply: (tx, batch) =>
            boundary(
                Effect.gen(function* () {
                    yield* checkDelivery(tx, batch.metadata);
                    if (options.source && (yield* tx.query(outbox, { limit: 1 })).length > 0)
                        yield* batch.forEach((change) =>
                            change.kind === "put" && change.record.kind === "completed"
                                ? boundary(preserveReceipt(tx, change.record.value))
                                : Effect.void
                        );
                }).pipe(Effect.withSpan("Replica.delivery.preserveReceipts"))
            ),
        apply: (tx, batch) =>
            boundary(
                Effect.gen(function* () {
                    const currentInterests = yield* checkDelivery(tx, batch.metadata);
                    const current = yield* position(tx);
                    if (
                        batch.kind === "patch" &&
                        (current.deliveryMembershipVersion !== 1 || current.deliveryResident === false)
                    )
                        return yield* fault(
                            "HistoryExpired",
                            "Cached delivery membership must be rebuilt from a snapshot."
                        );
                    const deliverySelection = JSON.stringify(
                        [...new Set(batch.metadata.coverage.map((entry) => subsetKey(entry.subset)))].sort()
                    );
                    const changedView = current.deliverySelection !== deliverySelection;
                    // A new query set replaces completeness claims even when its
                    // row delta continues the same installed delivery stream.
                    if (changedView && batch.kind !== "snapshot") yield* tx.clear(coverage);
                    if (batch.kind === "snapshot") {
                        yield* tx.clear(deliveryRows);
                        for (const [type] of views) {
                            yield* clearRowBlobs(tx, type, "base");
                        }
                        if (options.source) {
                            yield* tx.clear(importedPending);
                            yield* tx.clear(importedCompleted);
                        }
                        yield* tx.clear(coverage);
                    }
                    const rootUpdates = new Map<string, Set<Key>>();
                    const updateRoots = (objectType: string, key: Key) => {
                        if (!options.blobs || !attachmentTypes.has(objectType)) return;
                        const keys = rootUpdates.get(objectType) ?? new Set<Key>();
                        keys.add(key);
                        rootUpdates.set(objectType, keys);
                    };
                    let baseType: string | undefined;
                    let baseRows: Row<ObjectValue>[] = [];
                    const baseKeys = new Set<Key>();
                    const flushBase = Effect.fnUntraced(function* () {
                        if (!baseRows.length) return;
                        const objectType = baseType!;
                        const rows = baseRows;
                        baseRows = [];
                        baseType = undefined;
                        baseKeys.clear();
                        const v = yield* view(objectType);
                        yield* putIncomingBaseRows(
                            tx,
                            v,
                            definitions.get(objectType)!.primaryKey,
                            encryptedProperties.get(objectType)!,
                            rows
                        );
                        yield* tx.putMany(
                            deliveryRows,
                            rows.map((row) => ({
                                key: deliveryKey({ kind: "base", objectType, key: row.key }),
                                value: true,
                            }))
                        );
                        const accessedAt = yield* Clock.currentTimeMillis;
                        yield* tx.putMany(
                            retention,
                            rows.map((row) => ({
                                key: identity(objectType, row.key),
                                value: { objectType, key: row.key, accessedAt },
                            }))
                        );
                        for (const row of rows) updateRoots(objectType, row.key);
                    });
                    yield* batch
                        .forEach((change) =>
                            boundary(
                                Effect.gen(function* () {
                                    if (change.kind === "put" && change.record.kind === "base") {
                                        const { objectType, key, value } = change.record;
                                        if (baseRows.length && (baseType !== objectType || baseKeys.has(key)))
                                            yield* flushBase();
                                        baseType = objectType;
                                        baseRows.push({ key, value });
                                        baseKeys.add(key);
                                        if (baseRows.length === 128) yield* flushBase();
                                        return;
                                    }
                                    yield* flushBase();
                                    const ref = change.kind === "put" ? change.record : change.ref;
                                    if (!("objectType" in ref)) {
                                        if (!options.source)
                                            return yield* fault(
                                                "InvalidResponse",
                                                "A committed source published speculative actions."
                                            );
                                        const table =
                                            ref.kind === "pending" ? importedPending : importedCompleted;
                                        if (
                                            change.kind === "put" &&
                                            (change.record.kind === "pending" ||
                                                change.record.kind === "completed")
                                        ) {
                                            if (change.record.value.invocation.id !== ref.id)
                                                return yield* fault(
                                                    "InvalidResponse",
                                                    "Incoming action key differs from its ID."
                                                );
                                            yield* tx.put(table, ref.id, change.record.value);
                                        } else yield* tx.delete(table, ref.id);
                                        return;
                                    }
                                    const v = yield* view(ref.objectType);
                                    if (change.kind === "put")
                                        yield* tx.put(deliveryRows, deliveryKey(ref), true);
                                    else yield* tx.delete(deliveryRows, deliveryKey(ref));
                                    if (ref.kind === "override" && !v.inherited)
                                        return yield* fault(
                                            "InvalidResponse",
                                            "A committed source published an override."
                                        );
                                    if (change.kind === "remove") {
                                        if (changedView) {
                                            // Leaving a view is not evidence that an unrelated
                                            // cached object was deleted. Match snapshot repair:
                                            // repair the new selected region, retaining other
                                            // rows without their old completeness proof.
                                            const values = [
                                                yield* tx.get(v.base, ref.key),
                                                yield* getBaseline(tx, v, ref.key),
                                                yield* getVisible(tx, v, ref.key),
                                            ];
                                            const refreshed = values.some(
                                                (value) =>
                                                    value !== undefined &&
                                                    batch.metadata.coverage.some(
                                                        (entry) =>
                                                            entry.subset.objectType === ref.objectType &&
                                                            evaluateQuery([{ key: ref.key, value }], {
                                                                where: entry.subset.query?.where,
                                                            }).length > 0
                                                    )
                                            );
                                            if (!refreshed) return;
                                        }
                                        yield* ref.kind === "base"
                                            ? tx.delete(v.base, ref.key)
                                            : tx.delete(v.inherited!, ref.key);
                                    } else if (
                                        change.record.kind === "base" ||
                                        change.record.kind === "override"
                                    )
                                        yield* putIncomingRow(
                                            tx,
                                            v,
                                            definitions.get(ref.objectType)!.primaryKey,
                                            encryptedProperties.get(ref.objectType)!,
                                            ref.key,
                                            change.record
                                        );
                                    yield* touch(tx, ref.objectType, ref.key);
                                    updateRoots(ref.objectType, ref.key);
                                })
                            )
                        )
                        .pipe(Effect.andThen(flushBase()), Effect.withSpan("Replica.delivery.applyRecords"));
                    if (batch.kind === "snapshot" || changedView) {
                        yield* Effect.gen(function* () {
                            // Membership is small metadata in this transaction.
                            // Reading it once avoids a separately guarded lookup
                            // for every cached row during view repair.
                            const installed = new Set((yield* tx.query(deliveryRows)).map((row) => row.key));
                            // A replacement only repairs its selected region. Other cached
                            // rows retain ordinary demand/pin/outbox/age-based GC semantics.
                            for (const [objectType, v] of views) {
                                for (const [kind, table] of [
                                    ["base", v.base],
                                    ["override", v.inherited],
                                ] as const) {
                                    if (!table) continue;
                                    let after: Key | undefined;
                                    for (;;) {
                                        const keys = yield* tx.keys(
                                            table as Table<ObjectValue | Override<ObjectValue>>,
                                            { after, limit: 128 }
                                        );
                                        for (const key of keys)
                                            yield* boundary(
                                                Effect.gen(function* () {
                                                    let removed = false;
                                                    if (
                                                        !installed.has(deliveryKey({ kind, objectType, key }))
                                                    ) {
                                                        const base = yield* tx.get(v.base, key);
                                                        const baseline = yield* getBaseline(tx, v, key);
                                                        const visible = yield* getVisible(tx, v, key);
                                                        const refreshed =
                                                            installed.has(
                                                                deliveryKey({
                                                                    kind:
                                                                        kind === "base" ? "override" : "base",
                                                                    objectType,
                                                                    key,
                                                                })
                                                            ) ||
                                                            [base, baseline, visible].some(
                                                                (value) =>
                                                                    value !== undefined &&
                                                                    batch.metadata.coverage.some(
                                                                        (entry) =>
                                                                            entry.subset.objectType ===
                                                                                objectType &&
                                                                            evaluateQuery([{ key, value }], {
                                                                                where: entry.subset.query
                                                                                    ?.where,
                                                                            }).length > 0
                                                                    )
                                                            );
                                                        if (refreshed) {
                                                            removed = true;
                                                            yield* tx.delete(
                                                                table as Table<
                                                                    ObjectValue | Override<ObjectValue>
                                                                >,
                                                                key
                                                            );
                                                            if (
                                                                kind === "base" &&
                                                                v.inherited &&
                                                                !installed.has(
                                                                    deliveryKey({
                                                                        kind: "override",
                                                                        objectType,
                                                                        key,
                                                                    })
                                                                )
                                                            )
                                                                yield* tx.delete(v.inherited, key);
                                                        }
                                                    }
                                                    if (batch.kind === "snapshot" || removed)
                                                        updateRoots(objectType, key);
                                                })
                                            );
                                        if (keys.length < 128) break;
                                        after = keys.at(-1);
                                    }
                                }
                            }
                        }).pipe(Effect.withSpan("Replica.delivery.repairSnapshot"));
                    }
                    // Retain only the final composed baseline, once per changed
                    // identity. Inherited records can change or disappear after
                    // a base record, so earlier per-record reconciliation repeats
                    // work and can temporarily protect the wrong attachment.
                    yield* Effect.gen(function* () {
                        for (const [objectType, changed] of rootUpdates) {
                            const v = views.get(objectType)!;
                            const keys = [...changed];
                            for (let offset = 0; offset < keys.length; offset += 128) {
                                const page = keys.slice(offset, offset + 128);
                                const bases = new Map(
                                    (yield* tx.getMany(v.base, page)).map((row) => [row.key, row.value])
                                );
                                const inherited = v.inherited
                                    ? new Map(
                                          (yield* tx.getMany(v.inherited, page)).map((row) => [
                                              row.key,
                                              row.value,
                                          ])
                                      )
                                    : undefined;
                                for (const key of page) {
                                    const entry = inherited?.get(key);
                                    yield* retainRowBlobs(
                                        tx,
                                        objectType,
                                        key,
                                        bases.get(key),
                                        "base",
                                        entry ? (entry.deleted ? undefined : entry.value) : bases.get(key)
                                    );
                                }
                            }
                        }
                    }).pipe(Effect.withSpan("Replica.delivery.retainAttachments"));
                    for (const entry of batch.metadata.coverage) {
                        yield* tx.put(coverage, subsetKey(entry.subset), {
                            subset: entry.subset,
                            complete: entry.complete || entry.cached === true,
                            invalidated: !entry.complete,
                            snapshotCursor: batch.metadata.cursor,
                            updatedAt: yield* Clock.currentTimeMillis,
                        });
                        for (const demand of demands.values()) {
                            if (
                                subsetKey({
                                    ...demand.subset,
                                    query: retentionQuery(demand.subset.query),
                                }) === subsetKey(entry.subset)
                            )
                                yield* tx.put(coverage, subsetKey(demand.subset), {
                                    subset: demand.subset,
                                    complete: entry.complete || entry.cached === true,
                                    invalidated: !entry.complete,
                                    snapshotCursor: batch.metadata.cursor,
                                    updatedAt: yield* Clock.currentTimeMillis,
                                });
                        }
                    }
                    yield* tx.put(metadata, "head", {
                        ...current,
                        cursor: batch.metadata.cursor,
                        deliverySelection,
                        deliveryMembershipVersion: 1,
                        deliveryResident: true,
                    });
                    if (options.source) {
                        const selected = current.parentViewIdentity
                            ? Table.make<{ actionIds: readonly string[] }>({ name: "view-identity" }).decode(
                                  current.parentViewIdentity
                              )
                            : undefined;
                        // Positive outcomes remain valid in an older same-row target.
                        // Its absence cannot establish expiry for newer interests.
                        yield* settleParentActions(
                            tx,
                            (yield* tx.query(importedPending)).map((row) => row.value),
                            (yield* tx.query(importedCompleted)).map((row) => row.value),
                            currentInterests ? selected?.actionIds : undefined
                        );
                        yield* tx.put(imported, "head", {
                            sourceId,
                            revision: batch.metadata.revision,
                            definition: signature,
                            resident: true,
                            view: { generation: batch.metadata.generation },
                        });
                    }
                    yield* rebase(tx);
                })
            ),
    });
    const acquireDemand = Effect.fnUntraced(function* (subset: CompiledSubset) {
        yield* view(subset.objectType);
        const prepared = yield* Effect.try({
            try: () => {
                evaluateQuery([], subset.query ?? {});
                const definition = definitions.get(subset.objectType)!;
                const properties = new Set(definition.properties.map((property) => property.name));
                const codec = Table.make<CompiledSubset>({ name: "subset-copy" });
                return {
                    // Initialization already installed the unique scalar PK
                    // index. Automatic query indexes need no duplicate copy.
                    indexes: indexesForQuery(subset.query ?? {}, properties).filter(
                        (index) =>
                            index.multiEntry ||
                            index.field.path.length !== 1 ||
                            index.field.path[0] !== definition.primaryKey
                    ),
                    key: subsetKey(subset),
                    copy: codec.decode(codec.encode(subset)),
                };
            },
            catch: (cause) => fault("InvalidRequest", "Invalid subset query.", cause),
        });
        for (const index of prepared.indexes) yield* service.ensureIndex(subset.objectType, index);
        const { key, copy } = prepared;
        yield* retain(subset.objectType, "remote", key, copy);
        yield* Effect.makeSpanScoped("Replica.demand", {
            root: true,
            attributes: { activity: "subscription", objectType: subset.objectType },
        });
        if (deliveryActive) {
            yield* wakeState;
            return;
        }
        if (!options.source && options.live === false) return;
        const remoteSubset = copy.query ? { ...copy, query: retentionQuery(copy.query) } : copy;
        const sourceWatch = options.source?.demand(remoteSubset);
        const backendWatch = options.source
            ? undefined
            : adapter!.watchSubset?.(objectSubset(copy.objectType, copy.query));
        const watched = sourceWatch ?? backendWatch;
        const configuredInterval =
            options.demand?.refresh?.pollIntervalMs ??
            adapter?.refresh?.(objectSubset(copy.objectType, copy.query))?.pollIntervalMs ??
            false;
        const demand = demands.get(key)!;
        demand.watched = Boolean(watched);
        demand.pollDisabled = !watched && configuredInterval === false;
        const pollIntervalMs =
            watched || adapter?.changes || configuredInterval === false ? undefined : configuredInterval;
        if (pollIntervalMs !== undefined && (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 100))
            return yield* fault("InvalidConfiguration", "Subset poll interval must be at least 100 ms.");
        const polling =
            pollIntervalMs === undefined ? undefined : Stream.fromEffectRepeat(Effect.sleep(pollIntervalMs));
        if (!watched && demand.watchReady) {
            yield* Deferred.succeed(demand.watchReady, undefined);
            yield* wakeState;
        }
        if (!watched && !polling) return;
        const ready = options.source ? yield* Deferred.make<void, BackendError>() : undefined;
        demand.sourceReady = ready;
        let firstWatch = true;
        demand.pollIntervalMs = pollIntervalMs;
        const invalidateCoverage = Effect.sync(() => coverageGenerations.set(copy.objectType, Symbol())).pipe(
            Effect.andThen(
                boundary(
                    tables.transaction((tx) =>
                        Effect.gen(function* () {
                            for (const cached of yield* tx.query(coverage, {
                                where: eq(field("subset", "objectType"), copy.objectType),
                            }))
                                // Several subset watches can report the same source change.
                                // Keep the generation fence above, but do not rewrite every
                                // already-invalid proof for each callback.
                                if (!cached.value.invalidated)
                                    yield* tx.put(coverage, cached.key, {
                                        ...cached.value,
                                        invalidated: true,
                                    });
                        })
                    )
                )
            ),
            Effect.withSpan("Replica.invalidateCoverage", { attributes: { objectType: copy.objectType } })
        );
        const resetCoverage = boundary(
            tables.transaction((tx) =>
                Effect.gen(function* () {
                    const records = yield* tx.query(coverage, {
                        where: eq(field("subset", "objectType"), copy.objectType),
                    });
                    const maintained = records.filter((record) => {
                        const other = demands.get(String(record.key));
                        return (
                            record.value.complete &&
                            !record.value.invalidated &&
                            other &&
                            other !== demand &&
                            other.watchers > 0 &&
                            other.pollIntervalMs === undefined &&
                            !other.watchFailure &&
                            other.installed === other.revision
                        );
                    });
                    for (const record of records) {
                        // A healthy watcher maintains its actual requested scope, never
                        // a broader expanded fulfillment advertised by its adapter.
                        if (
                            !record.value.invalidated &&
                            !maintained.some((proof) => coversSubset(record.value.subset, proof.value.subset))
                        )
                            yield* tx.put(coverage, record.key, { ...record.value, invalidated: true });
                    }
                    return maintained.some((proof) => coversSubset(copy, proof.value.subset));
                })
            )
        );
        yield* Effect.forkScoped(
            superviseWatch({
                acquire: () =>
                    Effect.gen(function* () {
                        if (options.source) yield* awaitAuthentication;
                        const initial = firstWatch;
                        firstWatch = false;
                        if (backendWatch && !initial) demand.watchReady = yield* Deferred.make<void>();
                        const acquisition =
                            backendWatch &&
                            (initial
                                ? backendWatch
                                : adapter!.watchSubset?.(objectSubset(copy.objectType, copy.query)));
                        if (backendWatch && !acquisition)
                            return yield* fault(
                                "InvalidConfiguration",
                                "Subset watch is no longer available."
                            );
                        const stream = acquisition
                            ? yield* acquisition
                            : sourceWatch
                              ? initial
                                  ? sourceWatch
                                  : options.source!.demand(remoteSubset)
                              : polling!;
                        if (backendWatch) {
                            // Acquisition closes the missed-event gap. Fence an old
                            // finite read before repairing this watch's own proof.
                            if (!initial || demand.installed !== 0) demand.revision++;
                            yield* resetCoverage;
                        }
                        yield* Effect.acquireRelease(
                            Effect.sync(() => {
                                demand.watchers++;
                            }).pipe(Effect.andThen(diagnostics.changed)),
                            () =>
                                Effect.sync(() => {
                                    demand.watchers--;
                                }).pipe(Effect.andThen(diagnostics.changed))
                        );
                        return stream;
                    }),
                // A protocol parent may be a local worker while the device is
                // offline. Its transport failures, not upstream connectivity,
                // determine whether this lease needs retrying.
                canRun: options.source ? undefined : canSync,
                authentication,
                onValue: (event) =>
                    Effect.gen(function* () {
                        // Fence this watch's old request synchronously. A reset
                        // repairs its own missed events; unrelated healthy watches
                        // retain their proofs and their in-flight type generation.
                        if (!demand.loadFailure || demand.loadFailure.error.retryable) demand.revision++;
                        const maintained =
                            event === "reset" ? yield* resetCoverage : (yield* invalidateCoverage, false);
                        yield* Effect.annotateCurrentSpan("reusedCoverage", maintained);
                        yield* diagnostics.changed;
                        yield* wakeState;
                        if (ready) yield* Deferred.succeed(ready, undefined);
                    }).pipe(
                        Effect.withSpan("Replica.watchHint", {
                            attributes: {
                                objectType: copy.objectType,
                                hint: event === "reset" ? "reset" : "invalidate",
                            },
                        })
                    ),
                onError: (error, attempt) =>
                    Effect.sync(() => {
                        // Only an attempt that was delivering hints can have dropped one.
                        // A watch that never opened or never reported a change leaves
                        // its snapshot valid: mark the demand unmaintained so coverage
                        // falls back to age-based revalidation instead of reloading now.
                        // Successful re-acquisitions still repair the gap (see acquire).
                        const missed = error !== undefined && (attempt?.delivered ?? true);
                        if (missed || (!error && demand.watchFailure)) demand.revision++;
                        demand.watchFailure = error;
                        return missed;
                    }).pipe(
                        Effect.flatMap((missed) =>
                            missed
                                ? invalidateCoverage.pipe(Effect.catch(service.reportReplicationFailure))
                                : Effect.void
                        ),
                        Effect.andThen(diagnostics.changed),
                        Effect.andThen(
                            demand.watchReady ? Deferred.succeed(demand.watchReady, undefined) : Effect.void
                        ),
                        Effect.andThen(wakeState),
                        Effect.andThen(localNotify),
                        Effect.andThen(ready && error ? Deferred.fail(ready, error) : Effect.void)
                    ),
                // A provider that rejects this watch outright is not retried. Fall back
                // to the route's poll policy when configured; otherwise coverage ages out.
                onTerminal: () =>
                    watched && typeof configuredInterval === "number"
                        ? Effect.gen(function* () {
                              demand.pollIntervalMs = configuredInterval;
                              yield* diagnostics.changed;
                              for (;;) {
                                  yield* Effect.sleep(configuredInterval);
                                  demand.revision++;
                                  yield* invalidateCoverage.pipe(
                                      Effect.catch(service.reportReplicationFailure)
                                  );
                                  yield* wakeState;
                              }
                          })
                        : Effect.void,
            }).pipe(
                Effect.withSpan("Replica.watchSubset", {
                    root: true,
                    attributes: { activity: "subscription", objectType: copy.objectType },
                })
            ),
            { startImmediately: true }
        );
        if (ready) {
            // A scoped lease can expose its previously confirmed resident
            // snapshot while the new watch opens. Explicit fresh reads await
            // sourceReady below; this proof establishes only cached availability.
            const cached = yield* access(tables.read((tx) => cachedCoverageFor(tx, copy)));
            if (!cached) yield* Deferred.await(ready);
        }
    });
    const demandCodec = Table.make<CompiledSubset>({ name: "demand" });
    const demandCache = yield* makeDemandCache({
        policy: options.demand,
        acquire: (key) => acquireDemand(demandCodec.decode(key)),
    });
    const waitForDelivery = (
        subset: CompiledSubset | undefined,
        resultType: "cached" | "complete" = "complete"
    ) =>
        Effect.scoped(
            Effect.gen(function* () {
                if (!deliveryActive) return;
                if (options.source) yield* awaitAuthentication;
                else if (!(yield* canSync)) return;
                // Subscribe before inspecting state: installation can finish between
                // the read and the wait. Readiness is scoped, not a ten-second IO budget.
                const updates = yield* PubSub.subscribe(events);
                for (;;) {
                    if (options.source) yield* awaitAuthentication;
                    else if (!(yield* canSync)) return;
                    if (replicationError?.recovery === "stop")
                        return yield* fault(replicationError.kind, replicationError.message);
                    const installed = yield* receiver.installed;
                    const proof =
                        subset && installed?.metadata
                            ? yield* access(
                                  tables.read((tx) =>
                                      resultType === "cached"
                                          ? cachedCoverageFor(tx, subset)
                                          : coverageFor(tx, subset)
                                  )
                              )
                            : undefined;
                    if (
                        installed?.metadata &&
                        (subset
                            ? // An unrelated demand/action interest can replace the selected
                              // generation without invalidating this query's installed rows.
                              proof?.complete === true && (resultType === "cached" || !proof.invalidated)
                            : options.source
                              ? installed.metadata.generation === (yield* requestedView()).generation
                              : yield* Effect.flatMap(requestedView(), (selected) =>
                                    access(
                                        tables.read((tx) =>
                                            Effect.forEach(selected.selection.subsets, (selectedSubset) =>
                                                service.hasCoverage(tx, selectedSubset)
                                            ).pipe(Effect.map((covered) => covered.every(Boolean)))
                                        )
                                    )
                                ))
                    ) {
                        const demand = subset && demands.get(subsetKey(subset));
                        if (
                            subset &&
                            demand &&
                            proof &&
                            !proof.invalidated &&
                            subsetKey(proof.subset) !== subsetKey(subset)
                        ) {
                            demand.installed = demand.revision;
                            demand.coveredBy = proof.subset;
                            demand.coverageProof = {
                                reason: isWholeCollection(proof.subset.query) ? "collection" : "query",
                                maintainedBy: "watch",
                            };
                        }
                        return;
                    }
                    yield* PubSub.take(updates);
                }
            })
        );
    const openingWatches = (requested?: ReadonlySet<string>) =>
        [...demands].filter(
            ([key, demand]) =>
                (requested === undefined || requested.has(key)) &&
                demand.installed !== demand.revision &&
                demand.watchReady !== undefined &&
                !Deferred.isDoneUnsafe(demand.watchReady)
        );
    // Only a fresh fetch needs the acquisition barrier. Recheck after taking the
    // gate, and wait outside it so a slow subscription cannot block other views
    // or action publication. Cached/offline reads keep their existing behavior.
    const syncReady = (requested?: ReadonlySet<string>) =>
        Effect.scoped(
            Effect.gen(function* () {
                const updates = yield* PubSub.subscribe(events);
                for (;;) {
                    yield* runStateSync(requested);
                    if (!(yield* canSync)) return;
                    const pending = openingWatches(requested);
                    if (pending.length === 0) return;
                    yield* Effect.raceFirst(
                        Effect.forEach(
                            pending,
                            ([, demand]) =>
                                Effect.raceFirst(
                                    Deferred.await(demand.watchReady!),
                                    Deferred.await(demand.released)
                                ),
                            { concurrency: "unbounded", discard: true }
                        ),
                        PubSub.take(updates)
                    );
                }
            })
        );
    // One selected view can contain many subsets. A state pass already checks
    // aggregate demand; repeating it per subset only serializes the same work.
    const syncSelection = (
        subsets: readonly CompiledSubset[],
        resultType: "cached" | "complete" = "complete"
    ) => {
        if (subsets.length === 0) return Effect.void;
        return deliveryActive
            ? wakeState.pipe(
                  Effect.andThen(
                      Effect.forEach(subsets, (subset) => waitForDelivery(subset, resultType), {
                          discard: true,
                      })
                  )
              )
            : options.source
              ? Effect.gen(function* () {
                    for (const subset of subsets) {
                        const ready = demands.get(subsetKey(subset))?.sourceReady;
                        if (ready) yield* Deferred.await(ready);
                    }
                    yield* service.refreshParent(options.source!);
                })
              : syncReady(new Set(subsets.map(subsetKey)));
    };
    const visibleRevision = (tx: ReadTransaction) =>
        tx.get(stateHead, "head").pipe(Effect.map((head) => head?.visibleRevision ?? 0));
    const service: ReplicaService = {
        proxyInvalidation: { writeGeneration: 0, invalidatedGeneration: 0, dirtyTypes: [] },
        reportWatchFailure: (error) =>
            Effect.sync(() => {
                changeWatchFailure = error;
            }).pipe(
                Effect.andThen(diagnostics.changed),
                Effect.andThen(wakeState),
                Effect.andThen(
                    error
                        ? Effect.logWarning("Replica change subscription failed", {
                              kind: error.kind,
                              retryable: error.retryable,
                          })
                        : Effect.void
                )
            ),
        localTransaction: (body) =>
            access(tables.transaction((tx) => body(tx, reader(tx, false)))).pipe(Effect.tap(() => notify)),
        visibleChanges: access(PubSub.subscribe(visibleEvents)).pipe(
            Effect.map((subscription) => Stream.fromSubscription(subscription).pipe(Stream.as(undefined)))
        ),
        visibleRevision,
        readVisibleRevision: access(tables.read(visibleRevision)),
        hasCoverage: (tx, subset) =>
            Effect.gen(function* () {
                const proof = yield* coverageFor(tx, subset);
                return proof?.complete === true && !proof.invalidated;
            }),
        outboxWakeups: outboxWake,
        reportReplicationFailure: (error) =>
            Effect.gen(function* () {
                const recovery = error && deliveryRecovery(error);
                replicationError =
                    error && recovery !== "selection"
                        ? { kind: error.kind, message: error.message, recovery: recovery! }
                        : undefined;
                yield* localNotify;
            }),
        observeRows: (objectType, query) =>
            observeRows({
                objectType,
                query,
                changes: access(PubSub.subscribe(visibleEvents)).pipe(Effect.map(Stream.fromSubscription)),
                read: (body) => access(tables.read(body)),
                snapshot: (tx) =>
                    Effect.gen(function* () {
                        const v = views.get(objectType);
                        if (!v)
                            return yield* new OntologyStorageError({
                                operation: "replica.observe",
                                reason: new ConfigurationError({ message: "Unknown object type." }),
                            });
                        return {
                            revision: (yield* tx.get(stateHead, "head"))?.visibleRevision ?? 0,
                            rows: yield* loadVisible(tx, v, query),
                        };
                    }),
            }).pipe(Stream.map((batch) => ({ ...batch, rows: publicRows(objectType, batch.rows) }))),
        subscribeSelection: (selection, policy, resume) =>
            traceDelivery(
                Effect.gen(function* () {
                    for (const subset of selection.subsets) yield* service.demand(subset);
                    yield* syncSelection(selection.subsets);
                    return yield* committedDeliveries.open({
                        policy: { retentionMs: options.clients?.deliveryRetentionMs, ...policy },
                        resume,
                        binding: JSON.stringify([ownSourceId, schemaHash]),
                        identity: JSON.stringify(selection),
                        changes: service.subscribeChanges,
                        capture: (tx, emit) =>
                            boundary(captureSelection(tx, { generation: 1, selection }, emit, false)),
                    });
                })
            ),
        subscribeClient: (session, selected, policy, resume) =>
            traceDelivery(
                Effect.gen(function* () {
                    yield* access(tables.transaction((tx) => clients.select(tx, session, selected)));
                    // The selected stream owns upstream demand too: no parallel
                    // lease RPC can silently lose interest while delivery stays open.
                    for (const subset of selected.selection.subsets) yield* service.demand(subset);
                    // Publish existing base/optimistic/action state immediately. Data
                    // refresh may be gated behind a submitting action; acceptance
                    // must remain deliverable while that action is still in flight.
                    const delivery = yield* speculativeDeliveries.open({
                        policy: { retentionMs: options.clients?.deliveryRetentionMs, ...policy },
                        resume,
                        binding: JSON.stringify([ownSourceId, schemaHash, session.client.clientId]),
                        identity: JSON.stringify(selected),
                        rowSelection: JSON.stringify(selected.selection.subsets),
                        changes: service.subscribeChanges,
                        renew: (tx) => boundary(clients.select(tx, session, selected)).pipe(Effect.asVoid),
                        capture: (tx, emit) =>
                            boundary(
                                Effect.gen(function* () {
                                    yield* clients.select(tx, session, selected);
                                    const meta = yield* captureSelection(tx, selected, emit, true);
                                    return {
                                        ...meta,
                                        client: yield* clients.deliver(tx, session, meta.revision),
                                    };
                                })
                            ),
                    });
                    return {
                        ...delivery,
                        frames: delivery.frames.pipe(
                            Stream.mergeEffect(syncSelection(selected.selection.subsets))
                        ),
                    };
                })
            ),
        parentDeliveryGeneration: requestedView().pipe(Effect.map((selected) => selected.generation)),
        openParentDelivery: (source) =>
            Effect.gen(function* () {
                yield* awaitAuthentication;
                const selected = yield* requestedView();
                const current = yield* access(tables.read(position));
                if (current.deliveryMembershipVersion !== 1 || current.deliveryResident === false)
                    yield* receiver.forget;
                const resume = yield* receiver.resume;
                const session = source ? yield* sessionFor(source) : undefined;
                const subscription = source?.subscribe
                    ? yield* source.subscribe(session!, selected, undefined, resume)
                    : yield* adapter!.subscribeSelection!(
                          {
                              subsets: selected.selection.subsets.map((s) =>
                                  objectSubset(s.objectType, s.query)
                              ),
                          },
                          undefined,
                          resume
                      );
                return {
                    generation: selected.generation,
                    session,
                    subscription,
                };
            }),
        resetParentDelivery: receiver.forget,
        receiveDelivery: Effect.fn("Replica.receiveDelivery")(function* (frame, generation) {
            if (frame.end) yield* requestedView();
            const receive =
                !options.source && frame.end
                    ? gate.withPermits(1)(Effect.andThen(requestedView(), receiver.receive(frame)))
                    : receiver.receive(frame);
            const result = yield* receive.pipe(Effect.provideService(deliveryGeneration, generation));
            if (result && !result.duplicate) {
                for (const demand of demands.values())
                    if (
                        result.metadata.coverage.some(
                            (entry) =>
                                entry.complete &&
                                (subsetKey({
                                    ...demand.subset,
                                    query: retentionQuery(demand.subset.query),
                                }) === subsetKey(entry.subset) ||
                                    (entry.subset.objectType === demand.subset.objectType &&
                                        isWholeCollection(entry.subset.query)))
                        )
                    )
                        demand.installed = demand.revision;
                yield* notify;
                yield* wake;
            }
            return result;
        }),
        snapshotSubset: (subset, confirmed = true) =>
            access(
                tables.read((tx) =>
                    Effect.gen(function* () {
                        const proof = yield* coverageFor(tx, subset);
                        return {
                            rows: publicRows(
                                subset.objectType,
                                yield* reader(tx, confirmed).loadSubset(subset.objectType, subset.query)
                            ),
                            complete: proof?.complete === true && !proof.invalidated,
                            cursor: (yield* position(tx)).cursor,
                        };
                    })
                )
            ),
        ir: options.ir,
        mode: options.source ? "protocol" : "adapter",
        connectivity,
        connection,
        status: Effect.gen(function* () {
            const pending = yield* access(tables.read(pendingIn));
            const measured = yield* access(options.tables.read(usage.measure));
            const outbox: Record<string, number> = {};
            for (const entry of pending) outbox[entry.state] = (outbox[entry.state] ?? 0) + 1;
            return {
                sourceId: ownSourceId,
                upstreamId: sourceId,
                mode: options.source ? ("protocol" as const) : ("adapter" as const),
                networkOnline: yield* connectivity.online,
                authentication: connection?.state,
                ...diagnostics.snapshot(),
                replicationError,
                watchError: changeWatchFailure && {
                    kind: changeWatchFailure.kind,
                    message: changeWatchFailure.message,
                    retryable: changeWatchFailure.retryable,
                },
                cache: {
                    objects: {
                        bytes: measured.bytes,
                        byObjectType: [...views].map(([objectType, view]) => ({
                            objectType,
                            bytes: [
                                view.base,
                                ...(view.inherited ? [view.inherited] : []),
                                view.overrides,
                            ].reduce((total, table) => total + (measured.byTable[table.name] ?? 0), 0),
                        })),
                        maxBytes: objectCacheGc?.maxBytes,
                        targetBytes: objectCacheGc?.targetBytes,
                    },
                },
                outbox,
                demands: [...demands.values()].map((demand) => ({
                    ...demand.subset,
                    ...demandCache.state(subsetKey(demand.subset)),
                    watchers: demand.watchers,
                    loadError: demand.loadFailure && {
                        kind: demand.loadFailure.error.kind,
                        message: demand.loadFailure.error.message,
                        retryable: demand.loadFailure.error.retryable,
                    },
                    watchError: demand.watchFailure && {
                        kind: demand.watchFailure.kind,
                        message: demand.watchFailure.message,
                        retryable: demand.watchFailure.retryable,
                    },
                    revision: demand.revision,
                    installed: demand.installed,
                    coveredBy: demand.installed === demand.revision ? demand.coveredBy : undefined,
                    coverageProof: demand.installed === demand.revision ? demand.coverageProof : undefined,
                })),
            };
        }).pipe(Effect.withSpan("Replica.engineStatus")),
        statuses: Stream.unwrap(
            Effect.gen(function* () {
                const changes = yield* diagnostics.subscribe;
                return Stream.concat(Stream.succeed(undefined), changes).pipe(
                    Stream.mapEffect(() => service.status)
                );
            })
        ),
        sourceId: ownSourceId,
        ...readOutside(false),
        encryptedCache: {
            get: (value) =>
                access(
                    tables.read((tx) =>
                        Effect.gen(function* () {
                            const source = value.source;
                            if (
                                !source ||
                                !encryptedProperties.get(source.objectType)?.includes(source.property)
                            )
                                return;
                            const v = yield* view(source.objectType);
                            const row = yield* getBaseline(tx, v, source.primaryKey);
                            const current = row?.[source.property] as Encrypted | undefined;
                            return current?.ciphertext === value.ciphertext ? cachedCopy(current) : undefined;
                        })
                    )
                ),
            put: (value, local) =>
                access(
                    tables.transaction((tx) =>
                        Effect.gen(function* () {
                            const source = value.source;
                            if (
                                !source ||
                                !encryptedProperties.get(source.objectType)?.includes(source.property)
                            )
                                return;
                            const v = yield* view(source.objectType);
                            const row = yield* getBaseline(tx, v, source.primaryKey);
                            const current = row?.[source.property] as Encrypted | undefined;
                            // A late response cannot recreate an evicted row or cache against a newer value.
                            if (!row || current?.ciphertext !== value.ciphertext) return;
                            const cached = { ...row, [source.property]: withCachedCopy(current, local) };
                            if (v.inherited && (yield* tx.get(v.inherited, source.primaryKey)))
                                yield* tx.put(v.inherited, source.primaryKey, {
                                    deleted: false,
                                    value: cached,
                                });
                            else yield* tx.put(v.base, source.primaryKey, cached);
                        })
                    )
                ),
        },
        confirmed: readOutside(true),
        changes: Stream.fromPubSub(events),
        subscribeChanges: access(PubSub.subscribe(events)).pipe(Effect.map(Stream.fromSubscription)),
        pending: access(tables.read(pendingIn)),
        pendingActions: access(
            tables.read((tx) =>
                Effect.gen(function* () {
                    const entries = new Map(
                        (yield* tx.query(importedPending)).map((row) => [
                            row.key,
                            { ...row.value, forwarding: false },
                        ])
                    );
                    for (const entry of yield* pendingIn(tx))
                        entries.set(entry.invocation.id, { ...entry, forwarding: Boolean(options.source) });
                    return [...entries.values()];
                })
            )
        ),
        parentState: access(tables.read(parentStateIn)),
        snapshotState: access(tables.read((tx) => snapshotStateIn(tx))),
        openClient: (resume) => access(options.tables.transaction((tx) => clients.open(tx, resume))),
        readClient: (session, view) =>
            access(
                options.tables.transaction((tx) =>
                    Effect.gen(function* () {
                        yield* clients.select(tx, session, view);
                        const state = yield* snapshotStateIn(tx, view);
                        const client = yield* clients.deliver(tx, session, state.revision);
                        const proofs =
                            view &&
                            (yield* Effect.forEach(view.selection.subsets, (subset) =>
                                Effect.gen(function* () {
                                    const proof = yield* coverageFor(tx, subset);
                                    const cached = proof?.complete
                                        ? proof
                                        : yield* cachedCoverageFor(tx, subset);
                                    return {
                                        subset,
                                        complete: proof?.complete === true && !proof.invalidated,
                                        ...(cached ? { cached: true } : {}),
                                    };
                                })
                            ));
                        return { state, client, ...(proofs ? { coverage: proofs } : {}) };
                    })
                )
            ),
        acceptClient: Effect.fn("Replica.acceptClient")(function* (request: ClientSubmission) {
            yield* open;
            if (!request.invocation.id || request.invocation.attachmentUploads?.length)
                return yield* fault(
                    "InvalidRequest",
                    "Protocol submissions require an invocation ID and staged attachment handles."
                );
            if (
                request.view &&
                !request.view.selection.inspectActions &&
                !request.view.selection.actionIds.includes(request.invocation.id)
            )
                return yield* fault("InvalidRequest", "The submission view must include its action outcome.");
            const fingerprint = Table.make<unknown>({ name: "submission-identity" }).encode({
                invocation: request.invocation,
                optimistic: request.optimistic,
            });
            yield* access(
                tables.transaction((tx) =>
                    Effect.gen(function* () {
                        yield* clients.select(tx, request.session, request.view);
                        for (const subset of request.view?.selection.subsets ?? []) {
                            yield* view(subset.objectType);
                            yield* Effect.try({
                                try: () => evaluateQuery([], subset.query ?? {}),
                                catch: (cause) => fault("InvalidRequest", "Invalid selected query.", cause),
                            });
                        }
                        return yield* clients.admit(tx, request.session, request.sequence, fingerprint, () =>
                            Effect.gen(function* () {
                                if (request.stagedAttachments?.length) {
                                    const declared = new Set(attachmentIds(request.invocation));
                                    if (request.stagedAttachments.some((id) => !declared.has(id)))
                                        return yield* fault(
                                            "InvalidRequest",
                                            "Staged attachments must belong to the submitted action."
                                        );
                                    if (!options.blobs)
                                        return yield* fault(
                                            "NotImplemented",
                                            "Attachment storage is unavailable."
                                        );
                                    yield* options.blobs
                                        .in(tx)
                                        .requireBytes(request.stagedAttachments)
                                        .pipe(
                                            Effect.mapError(
                                                (cause) =>
                                                    new BackendError({
                                                        operation: "replica.submit.attachments",
                                                        kind:
                                                            cause instanceof BlobStorageError &&
                                                            cause.kind === "NotFound"
                                                                ? "NotFound"
                                                                : "Unavailable",
                                                        retryable: true,
                                                        actionOutcome: "not-committed",
                                                        message:
                                                            "Required staged attachments must be transferred before acceptance.",
                                                        cause,
                                                    })
                                            )
                                        );
                                }
                                return yield* enqueueIn(tx, request.invocation, {
                                    optimistic: request.optimistic,
                                });
                            })
                        );
                    })
                )
            );
            yield* notify;
            yield* wake;
        }),
        submitClient: (request) =>
            service
                .acceptClient(request)
                .pipe(Effect.andThen(() => service.readClient(request.session, request.view))),
        acknowledgeDelivery: (position, speculative = true) =>
            (speculative ? speculativeDeliveries : committedDeliveries).acknowledge(position),
        acknowledgeClient: (session, revision, through, viewGeneration) =>
            access(
                options.tables.transaction((tx) =>
                    clients.acknowledge(tx, session, revision, through, viewGeneration)
                )
            ).pipe(Effect.asVoid),
        collectClientGarbage: access(options.tables.transaction((tx) => clients.expire(tx))).pipe(
            Effect.map((ids) => ids.length)
        ),
        refreshParent: Effect.fn("Replica.refreshParent")(function* (source: OntologySource) {
            if (connection && connection.state.status !== "active") return;
            const session = yield* sessionFor(source);
            const response = yield* source.read(session, yield* requestedView()).pipe(
                Effect.catch((error) => {
                    if (error.kind !== "SessionExpired" && error.kind !== "SessionReplaced")
                        return Effect.fail(error);
                    parentSession = undefined;
                    return Effect.gen(function* () {
                        const renewed = yield* sessionFor(source);
                        return yield* source.read(renewed, yield* requestedView());
                    });
                })
            );
            yield* adoptClientState(source, response);
        }),
        receiveParentState: Effect.fn("Replica.receiveParentState")(function* (
            snapshot: ReplicaStateSnapshot,
            requestedActionIds?: readonly string[],
            proofs?: ClientState["coverage"]
        ) {
            yield* open;
            if (!options.source)
                return yield* fault("NotImplemented", "This Replica uses the backend adapter interface.");
            if (snapshot.sourceId !== sourceId)
                return yield* fault("SourceMismatch", "Parent source changed; reset explicitly.");
            if (!sameDefinitionContract(snapshot.definition))
                return yield* fault(
                    "SchemaMismatch",
                    "Parent definition changed; migrate or reset explicitly."
                );
            if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1)
                return yield* fault("InvalidResponse", "Invalid parent revision.");
            if (
                snapshot.view &&
                (!Number.isSafeInteger(snapshot.view.generation) || snapshot.view.generation < 1)
            )
                return yield* fault("InvalidResponse", "Invalid parent view generation.");
            const digest = yield* snapshotDigest(snapshot);
            const fresh = yield* boundary(
                tables.transaction((tx) =>
                    Effect.gen(function* () {
                        const head = yield* tx.get(imported, "head");
                        if (
                            (snapshot.view?.generation ?? 0) < (head?.view?.generation ?? 0) ||
                            (head && snapshot.revision < head.revision)
                        )
                            return false;
                        if (
                            head &&
                            snapshot.revision === head.revision &&
                            (snapshot.view?.generation ?? 0) === (head.view?.generation ?? 0) &&
                            head.digest &&
                            head.digest !== digest
                        )
                            return yield* fault("Conflict", "Parent reused a revision for different state.");
                        for (const result of snapshot.completed) {
                            const local = yield* tx.get(outbox, result.invocation.id);
                            if (!local || !result.receipt) continue;
                            if (
                                result.receipt.operationId !== local.invocation.id ||
                                (result.requestIdentity !== local.requestIdentity &&
                                    result.requestIdentity !==
                                        Table.make<ActionRequest>({ name: "invocation" }).encode(
                                            local.invocation
                                        ))
                            )
                                return yield* fault(
                                    "Conflict",
                                    "Parent result differs from the local action."
                                );
                            yield* tx.put(outbox, result.invocation.id, {
                                ...local,
                                receipt: result.receipt,
                                state: "acknowledged",
                            });
                        }
                        return true;
                    })
                )
            );
            if (!fresh) return;

            const installCoverage = (tx: Transaction) =>
                Effect.gen(function* () {
                    let changed = false;
                    for (const proof of proofs ?? []) {
                        const matched = [
                            proof.subset,
                            ...[...demands.values()]
                                .filter(
                                    (demand) =>
                                        subsetKey({
                                            ...demand.subset,
                                            query: retentionQuery(demand.subset.query),
                                        }) === subsetKey(proof.subset)
                                )
                                .map((demand) => demand.subset),
                        ];
                        for (const subset of matched) {
                            const key = subsetKey(subset);
                            const previous = yield* tx.get(coverage, key);
                            const complete = proof.complete || proof.cached === true;
                            const invalidated = !proof.complete;
                            if (
                                previous?.complete !== complete ||
                                Boolean(previous?.invalidated) !== invalidated
                            )
                                changed = true;
                            yield* tx.put(coverage, key, {
                                subset,
                                complete,
                                invalidated,
                                updatedAt: yield* Clock.currentTimeMillis,
                            });
                        }
                    }
                    return changed;
                });
            const changed = yield* boundary(
                tables.transaction((tx) =>
                    Effect.gen(function* () {
                        const prior = yield* tx.get(imported, "head");
                        const priorView = prior?.view?.generation ?? 0;
                        const nextView = snapshot.view?.generation ?? 0;
                        if (nextView < priorView) return false;
                        if (prior && snapshot.revision < prior.revision) return false;
                        if (prior && nextView === priorView && snapshot.revision === prior.revision) {
                            const previousDigest =
                                prior.digest ?? (yield* snapshotDigest((yield* parentStateIn(tx))!));
                            if (previousDigest !== digest)
                                return yield* fault(
                                    "Conflict",
                                    "Parent reused a revision for different state."
                                );
                            if (prior.resident !== false) {
                                if (!prior.digest) yield* tx.put(imported, "head", { ...prior, digest });
                                return yield* installCoverage(tx);
                            }
                        }
                        const objectTypes = new Set(snapshot.objects.map((object) => object.objectType));
                        if (objectTypes.size !== views.size || snapshot.objects.length !== views.size)
                            return yield* fault(
                                "InvalidResponse",
                                "The proof requires a complete snapshot of all modeled types."
                            );
                        for (const object of snapshot.objects) {
                            const v = yield* view(object.objectType);
                            const primaryKey = definitions.get(object.objectType)!.primaryKey;
                            const inherited = v.inherited!;
                            const preserved = new Map<Key, ObjectValue>();
                            const properties = encryptedProperties.get(object.objectType)!;
                            const preservedOverrides = new Map<Key, ObjectValue>();
                            if (properties.length) {
                                for (const row of object.base)
                                    preserved.set(
                                        row.key,
                                        preserveCachedCopies(
                                            yield* tx.get(v.base, row.key),
                                            row.value,
                                            properties
                                        )
                                    );
                                for (const row of object.overrides)
                                    if (!row.value.deleted)
                                        preservedOverrides.set(
                                            row.key,
                                            preserveCachedCopies(
                                                yield* getBaseline(tx, v, row.key),
                                                row.value.value,
                                                properties
                                            )
                                        );
                            }
                            yield* clearRowBlobs(tx, object.objectType, "base");
                            yield* tx.clear(v.base);
                            yield* tx.clear(inherited);
                            for (const row of object.base) {
                                if (row.value[primaryKey] !== row.key)
                                    return yield* fault(
                                        "InvalidResponse",
                                        "Parent base key does not match its row."
                                    );
                                yield* tx.put(v.base, row.key, preserved.get(row.key) ?? row.value);
                                yield* touch(tx, object.objectType, row.key);
                            }
                            for (const row of object.overrides) {
                                yield* touch(tx, object.objectType, row.key);
                                if (!row.value.deleted) {
                                    if (row.value.value[primaryKey] !== row.key)
                                        return yield* fault(
                                            "InvalidResponse",
                                            "Parent projection key does not match its row."
                                        );
                                }
                                yield* tx.put(
                                    inherited,
                                    row.key,
                                    row.value.deleted
                                        ? row.value
                                        : {
                                              deleted: false,
                                              value: preservedOverrides.get(row.key) ?? row.value.value,
                                          }
                                );
                            }
                        }
                        for (const object of snapshot.objects) {
                            const v = views.get(object.objectType)!;
                            for (const key of new Set(
                                [...object.base, ...object.overrides].map((row) => row.key)
                            ))
                                yield* retainRowBlobs(
                                    tx,
                                    object.objectType,
                                    key,
                                    yield* tx.get(v.base, key),
                                    "base",
                                    yield* getBaseline(tx, v, key)
                                );
                        }
                        yield* settleParentActions(
                            tx,
                            snapshot.pending,
                            snapshot.completed,
                            requestedActionIds
                        );
                        yield* tx.clear(importedPending);
                        yield* tx.clear(importedCompleted);
                        for (const entry of snapshot.pending)
                            yield* tx.put(importedPending, entry.invocation.id, entry);
                        for (const entry of snapshot.completed)
                            yield* tx.put(importedCompleted, entry.invocation.id, entry);
                        yield* tx.put(imported, "head", {
                            sourceId: snapshot.sourceId,
                            revision: snapshot.revision,
                            definition: snapshot.definition,
                            digest,
                            resident: true,
                            ...(snapshot.view ? { view: snapshot.view } : {}),
                        });
                        yield* tx.clear(coverage);
                        yield* installCoverage(tx);
                        yield* rebase(tx);
                        return true;
                    })
                )
            );
            if (changed) {
                yield* notify;
                yield* wakeOutbox;
            }
        }),
        syncParent: (source) =>
            (deliveryActive ? Effect.void : service.refreshParent(source)).pipe(
                Effect.andThen(service.forwardParentActions(source))
            ),
        forwardParentActions: Effect.fn("Replica.forwardParentActions", { root: true })(
            function* (source: OntologySource) {
                yield* open;
                if (connection && connection.state.status !== "active") return;
                yield* Effect.annotateCurrentSpan("stage", "open-parent-session");
                if (replicationError?.recovery === "stop")
                    return yield* fault(replicationError.kind, replicationError.message);
                const initialSession = yield* sessionFor(source);
                const first = (yield* access(tables.read(pendingIn))).find(
                    (entry) => entry.state !== "acknowledged"
                );
                if (
                    first?.nextAttemptAt !== undefined &&
                    first.nextAttemptAt > (yield* Clock.currentTimeMillis)
                )
                    return;
                // A lost reply/restart can leave a submission already accepted by the
                // parent. Recover that evidence before retrying; new writes need no prefetch.
                if (
                    first?.submission &&
                    (first.state === "sending" ||
                        first.failureOutcome === "unknown" ||
                        initialSession.acceptedThrough >= first.submission.sequence)
                )
                    yield* service.refreshParent(source);
                const session = yield* sessionFor(source);
                for (;;) {
                    if (connection && connection.state.status !== "active") return;
                    yield* Effect.annotateCurrentSpan("stage", "claim-action");
                    const entry = yield* access(
                        tables.transaction((tx) =>
                            Effect.gen(function* () {
                                const head = (yield* pendingIn(tx)).find(
                                    (entry) => entry.state !== "acknowledged"
                                );
                                if (!head || (head.state !== "queued" && head.state !== "sending")) return;
                                if (
                                    head.nextAttemptAt !== undefined &&
                                    head.nextAttemptAt > (yield* Clock.currentTimeMillis)
                                )
                                    return;
                                let claimed: PendingAction = {
                                    ...head,
                                    state: "sending",
                                    attempts: head.attempts + 1,
                                    failure: undefined,
                                    failureOutcome: head.failureOutcome === "unknown" ? "unknown" : undefined,
                                };
                                if (!head.submission) {
                                    const state = yield* position(tx);
                                    const sequence = (state.parentSubmissionSequence ?? 0) + 1;
                                    if (!Number.isSafeInteger(sequence))
                                        return yield* fault(
                                            "Internal",
                                            "Client submission sequence exhausted."
                                        );
                                    claimed = {
                                        ...claimed,
                                        submission: { clientId: session.client.clientId, sequence },
                                    };
                                    yield* tx.put(metadata, "head", {
                                        ...state,
                                        parentSubmissionSequence: sequence,
                                    });
                                } else if (head.submission.clientId !== session.client.clientId)
                                    return yield* fault(
                                        "Conflict",
                                        "Unresolved action belongs to another parent client; reconcile it before resubmission."
                                    );
                                yield* tx.put(outbox, head.invocation.id, claimed);
                                return claimed;
                            })
                        )
                    );
                    if (!entry) return;
                    yield* Effect.annotateCurrentSpan({
                        operationId: entry.invocation.id,
                        stage: "parent-acceptance",
                    });
                    yield* notify;
                    const result = yield* Effect.result(
                        Effect.gen(function* () {
                            const submission: ClientSubmission = {
                                session: yield* sessionFor(source),
                                sequence: entry.submission!.sequence,
                                invocation: entry.invocation,
                                optimistic: entry.optimistic,
                                view: yield* requestedView(),
                            };
                            if (deliveryActive) {
                                if (source.accept) yield* source.accept(submission);
                                else yield* source.submit(submission);
                                yield* access(
                                    tables.transaction((tx) =>
                                        Effect.gen(function* () {
                                            const current = yield* tx.get(outbox, entry.invocation.id);
                                            if (current && !current.includedInBase)
                                                yield* tx.put(outbox, entry.invocation.id, {
                                                    ...current,
                                                    state: "acknowledged",
                                                });
                                        })
                                    )
                                );
                                yield* notify;
                                return;
                            }
                            const snapshot = yield* source.submit(submission);
                            yield* adoptClientState(source, snapshot);
                            if (
                                (yield* service.pending).some(
                                    (item) => item.invocation.id === entry.invocation.id
                                )
                            )
                                return yield* fault(
                                    "Unavailable",
                                    "Parent acceptance is not yet present in the received state."
                                );
                        })
                    );
                    if (result._tag === "Failure") {
                        yield* access(
                            tables.transaction((tx) =>
                                Effect.gen(function* () {
                                    const current = yield* tx.get(outbox, entry.invocation.id);
                                    // A concurrent state import may already have handed this off.
                                    if (!current) return;
                                    yield* recordFailure(
                                        tx,
                                        current,
                                        result.failure,
                                        source.supportsIdempotency
                                    );
                                    yield* rebase(tx);
                                })
                            )
                        );
                        yield* notify;
                        return yield* result.failure;
                    }
                }
            },
            (work) => gate.withPermits(1)(diagnostics.sync(work))
        ),
        receipt: (id) =>
            access(
                tables.read((tx) =>
                    Effect.gen(function* () {
                        return (
                            (yield* tx.get(completed, id))?.receipt ??
                            (yield* tx.get(importedCompleted, id))?.receipt
                        );
                    })
                )
            ),
        actionStatus: (id) =>
            access(
                tables.read((tx) =>
                    Effect.gen(function* () {
                        const parent = yield* tx.get(imported, "head");
                        const observed =
                            (yield* tx.get(importedPending, id)) ?? (yield* tx.get(importedCompleted, id));
                        const terminal =
                            (yield* tx.get(completed, id)) ?? (yield* tx.get(importedCompleted, id));
                        const local = yield* tx.get(outbox, id);
                        return {
                            pending: local?.includedInBase
                                ? ((yield* tx.get(importedPending, id)) ?? publicAction(local))
                                : local
                                  ? publicAction(local)
                                  : yield* tx.get(importedPending, id),
                            receipt:
                                (yield* tx.get(completed, id))?.receipt ??
                                (yield* tx.get(importedCompleted, id))?.receipt,
                            error: terminal?.failure
                                ? new BackendError({
                                      operation: "action.wait",
                                      kind: terminal.failure,
                                      message: terminal.failureMessage ?? "Action was discarded.",
                                      retryable: terminal.failureRetryable ?? false,
                                      actionOutcome: terminal.failureOutcome,
                                      issues: terminal.failureIssues,
                                  })
                                : undefined,
                            parentAcceptance:
                                // A successful Accept response is durable evidence even
                                // before the parent's selected state includes the action.
                                (options.source && local?.state === "acknowledged") ||
                                (parent && (observed || local?.includedInBase))
                                    ? { sourceId: parent?.sourceId ?? sourceId }
                                    : undefined,
                        };
                    })
                )
            ),
        awaitAction: (id, settings) =>
            Effect.scoped(
                Effect.gen(function* () {
                    yield* service.retainActions([id]);
                    const changes = yield* service.subscribeChanges;
                    const pull = yield* Stream.toPull(changes);
                    for (;;) {
                        const status = yield* service.actionStatus(id);
                        yield* Effect.annotateCurrentSpan({
                            state: status.pending?.state,
                            receipt: Boolean(status.receipt),
                            errorKind: status.error?.kind,
                            parentAccepted: Boolean(status.parentAcceptance),
                        });
                        if (status.receipt?.outcome === "committed") return status.receipt;
                        if (
                            settings?.until === "accepted" &&
                            (status.parentAcceptance ||
                                status.pending?.receipt ||
                                (!options.source && status.pending))
                        )
                            return status.pending?.receipt;
                        if (status.error) return yield* status.error;
                        const entry = status.pending;
                        if (!entry) return yield* fault("NotFound", "Action is no longer retained.");
                        if (entry.state === "blocked")
                            return yield* new BackendError({
                                operation: "action.wait",
                                kind: entry.failure ?? "Internal",
                                message:
                                    entry.failureMessage ??
                                    (entry.retryRequiresAcknowledgement === true
                                        ? "Remote outcome is unknown; reconcile or explicitly acknowledge a retry."
                                        : "Action is blocked; resolve its cause and retry or remove it."),
                                retryable: entry.failureRetryable ?? false,
                                actionOutcome: entry.failureOutcome,
                                issues: entry.failureIssues,
                            });
                        yield* pull.pipe(
                            Effect.mapError((cause) =>
                                fault("Unavailable", "Action observation failed.", cause)
                            )
                        );
                    }
                })
            ).pipe(
                Effect.withSpan("Replica.awaitAction", {
                    attributes: {
                        activity: "subscription",
                        operationId: id,
                        until: settings?.until ?? "confirmed",
                    },
                })
            ),
        reconcile: (id, receipt) =>
            access(
                tables.transaction((tx) =>
                    Effect.gen(function* () {
                        const entry = yield* tx.get(outbox, id);
                        if (!entry) return yield* fault("NotFound", "Action is no longer pending.");
                        if (entry.includedInBase || entry.state === "sending" || receipt.operationId !== id)
                            return yield* fault("Conflict", "Receipt does not match a recoverable action.");
                        yield* tx.put(outbox, id, {
                            ...entry,
                            receipt,
                            state: "acknowledged",
                            failure: undefined,
                            failureMessage: undefined,
                            nextAttemptAt: undefined,
                        });
                    })
                )
            ).pipe(
                Effect.tap(() => notify),
                Effect.tap(() => wakeOutbox)
            ),
        wake,
        syncSubset: (subset, settings) =>
            settings?.resultType === "cached"
                ? access(tables.read((tx) => cachedCoverageFor(tx, subset))).pipe(
                      Effect.flatMap((cached) => (cached ? Effect.void : syncSelection([subset], "cached")))
                  )
                : syncSelection([subset]),
        syncOnce: syncOnce.pipe(Effect.andThen(waitForDelivery(undefined))),
        enqueue: Effect.fn("Replica.enqueue", { root: true })(function* (
            invocation: ActionRequest,
            settings?: { optimistic?: boolean }
        ) {
            yield* open;
            if (!invocation.id) return yield* fault("InvalidRequest", "An invocation ID is required.");
            if (invocation.attachmentUploads?.length)
                return yield* fault(
                    "NotImplemented",
                    "Persist attachment handles in the outbox; stage bytes through the blob service before dispatch."
                );
            const entry = yield* access(tables.transaction((tx) => enqueueIn(tx, invocation, settings)));
            yield* notify;
            yield* wakeOutbox;
            return entry;
        }),
        acknowledgeParentRemoval: (id) =>
            access(
                tables.transaction((tx) =>
                    Effect.gen(function* () {
                        if ((yield* tx.get(outbox, id))?.includedInBase) yield* deletePending(tx, id);
                    })
                )
            ).pipe(Effect.tap(() => notify)),
        remove: (id, settings) =>
            Effect.suspend(() =>
                access(
                    tables.transaction((tx) =>
                        Effect.gen(function* () {
                            const entry = yield* tx.get(outbox, id);
                            if (
                                entry &&
                                (entry.includedInBase ||
                                    entry.state === "sending" ||
                                    entry.state === "acknowledged" ||
                                    (!settings?.allowUnknownOutcome &&
                                        entry.attempts > 0 &&
                                        entry.failureOutcome !== "not-committed"))
                            )
                                return yield* fault(
                                    "Conflict",
                                    "An action with a possible remote outcome cannot be discarded."
                                );
                            yield* deletePending(tx, id);
                            yield* rebase(tx);
                        })
                    )
                )
            ).pipe(
                Effect.tap(() => notify),
                Effect.tap(() => wake)
            ),
        edit: (id, invocation) =>
            Effect.suspend(() =>
                access(
                    tables.transaction((tx) =>
                        Effect.gen(function* () {
                            const entry = yield* tx.get(outbox, id);
                            if (
                                !entry ||
                                entry.includedInBase ||
                                (entry.attempts > 0 && entry.failureOutcome !== "not-committed") ||
                                invocation.id !== id ||
                                entry.state === "sending" ||
                                entry.state === "acknowledged" ||
                                entry.retryRequiresAcknowledgement === true
                            )
                                return yield* fault(
                                    "Conflict",
                                    "Only queued actions or actions rejected without committing can be edited."
                                );
                            if (options.blobs)
                                yield* options.blobs
                                    .in(tx)
                                    .retain(blobOwner(id), [
                                        ...attachmentIds(entry.invocation),
                                        ...attachmentIds(invocation),
                                    ]);
                            yield* tx.put(outbox, id, {
                                ...entry,
                                invocation: { ...invocation, replay: entry.invocation.replay },
                                requestIdentity: Table.make<ActionRequest>({
                                    name: "identity",
                                }).encode(invocation),
                                state: "queued",
                                failure: undefined,
                                failureMessage: undefined,
                                failureIssues: undefined,
                                // Editing requires a known-uncommitted request; the new
                                // payload has not been dispatched. Keep that evidence even
                                // though attempts includes earlier rejected payloads.
                                failureOutcome: "not-committed",
                                failureRetryable: undefined,
                                retryRequiresAcknowledgement: false,
                                nextAttemptAt: undefined,
                                retryFromAttempt: entry.attempts,
                            });
                            yield* rebase(tx);
                        })
                    )
                )
            ).pipe(
                Effect.tap(() => notify),
                Effect.tap(() => wakeOutbox)
            ),
        retry: (id, settings) =>
            Effect.suspend(() =>
                access(
                    tables.transaction((tx) =>
                        Effect.gen(function* () {
                            const entry = yield* tx.get(outbox, id);
                            if (!entry) return;
                            if (entry.includedInBase || entry.receipt || entry.state === "acknowledged")
                                return;
                            if (entry.state === "sending")
                                return yield* fault("Conflict", "An action is currently being dispatched.");
                            if (entry.retryRequiresAcknowledgement === true && !settings?.allowUnknownOutcome)
                                return yield* fault(
                                    "Conflict",
                                    "This source cannot deduplicate an ambiguous invocation; explicit retry acknowledgement is required."
                                );
                            yield* tx.put(outbox, id, {
                                ...entry,
                                state: "queued",
                                retryFromAttempt: entry.attempts,
                                nextAttemptAt: undefined,
                                failure: undefined,
                                failureMessage: undefined,
                                failureIssues: undefined,
                                failureRetryable: undefined,
                                retryRequiresAcknowledgement: false,
                            });
                            yield* rebase(tx);
                        })
                    )
                )
            ).pipe(
                Effect.tap(() => notify),
                Effect.tap(() => wakeOutbox)
            ),
        invalidate: (objectTypes) =>
            access(
                tables.transaction((tx) =>
                    Effect.gen(function* () {
                        for (const row of yield* tx.query(coverage))
                            if (!objectTypes || objectTypes.includes(row.value.subset.objectType))
                                yield* tx.delete(coverage, row.key);
                        for (const demand of demands.values())
                            if (!objectTypes || objectTypes.includes(demand.subset.objectType))
                                demand.revision++;
                    })
                )
            ).pipe(Effect.andThen(wakeState)),
        demand: Effect.fnUntraced(function* (subset) {
            const key = yield* Effect.try({
                try: () => subsetKey(subset),
                catch: (cause) => fault("InvalidRequest", "Invalid subset query.", cause),
            });
            yield* Effect.addFinalizer(() => diagnostics.changed);
            yield* demandCache.acquire(key);
            yield* diagnostics.changed;
        }),
        retainLocal: (objectType, query) =>
            Effect.gen(function* () {
                const subset = { objectType, query };
                const key = yield* Effect.try({
                    try: () => {
                        evaluateQuery([], query ?? {});
                        return subsetKey(subset);
                    },
                    catch: (cause) => fault("InvalidRequest", "Invalid local query.", cause),
                });
                yield* retain(objectType, "reader", `reader:${key}`, subset);
            }),
        retainActions: (ids) =>
            Effect.acquireRelease(
                Effect.gen(function* () {
                    yield* open;
                    if (ids)
                        yield* Schema.decodeUnknownEffect(Schema.Array(Schema.NonEmptyString))(ids).pipe(
                            Effect.mapError((cause) =>
                                fault("InvalidRequest", "Invalid action inspection IDs.", cause)
                            )
                        );
                    const key = crypto.randomUUID();
                    actionInterests.set(key, ids ? [...new Set(ids)] : undefined);
                    yield* localNotify;
                    return key;
                }),
                (key) =>
                    Effect.sync(() => {
                        actionInterests.delete(key);
                    }).pipe(Effect.andThen(localNotify))
            ).pipe(Effect.asVoid),
        pin: (objectType, key, pinned) =>
            access(
                Effect.flatMap(view(objectType), () =>
                    pinned
                        ? tables.put(pins, identity(objectType, key), { objectType, key })
                        : tables.delete(pins, identity(objectType, key))
                )
            ).pipe(Effect.tap(() => localNotify)),
        ensureIndex: (objectType, index) =>
            access(Effect.flatMap(view(objectType), (v) => tables.ensureIndex(v.base, index))),
        collectGarbage: Effect.fn("Replica.collectGarbage")(function* (settings?: ObjectCacheSweepOptions) {
            const limit = settings?.maxCandidates ?? 100;
            const max = objectCacheGc?.maxBytes;
            const before = max === undefined ? 0 : yield* access(options.tables.read(usage.total));
            const target =
                objectCacheGc?.targetBytes ?? (max === undefined ? undefined : Math.floor(max * 0.8));
            const pressure =
                max !== undefined &&
                (before > max || Boolean((yield* access(tables.get(sweep, "position")))?.reclaiming));
            if (pressure && (yield* demandCache.evictIdle()) > 0)
                yield* Queue.offer(cachePressure, undefined);
            const age = pressure ? 0 : (settings?.minUnusedAgeMs ?? 24 * 60 * 60 * 1000);
            if (
                !Number.isSafeInteger(limit) ||
                limit < 1 ||
                limit > 10000 ||
                !Number.isFinite(age) ||
                age < 0
            )
                return yield* fault("InvalidRequest", "Invalid GC bounds.");
            const now = yield* Clock.currentTimeMillis;
            const removed = yield* access(
                tables.transaction((tx) =>
                    Effect.gen(function* () {
                        // Client demand is owned here through RPC scopes/session leases.
                        // Acquisition and collection share the metadata transaction.
                        const cursor = (yield* tx.get(sweep, "position"))?.after;
                        const candidates = yield* tx.query(retention, {
                            where: lte(field("accessedAt"), now - age),
                            orderBy: [{ field: field("accessedAt") }],
                            limit,
                            after: cursor,
                        });
                        const pending = new Set([
                            ...(yield* pendingIn(tx)).map((entry) => entry.invocation.id),
                            ...(yield* acceptedIn(tx)).map((row) => row.value.invocation.id),
                        ]);
                        const markers = Effect.fnUntraced(function* (objectType: string) {
                            const v = views.get(objectType)!;
                            const queries: Query[] = [];
                            for (const root of yield* tx.query(roots, {
                                where: eq(field("objectType"), objectType),
                            })) {
                                queries.push(root.value.query ?? {});
                            }
                            for (const root of yield* tx.query(actionQueries, {
                                where: eq(field("subset", "objectType"), objectType),
                            })) {
                                if (pending.has(root.value.action))
                                    queries.push(root.value.subset.query ?? {});
                            }
                            const unique = new Map(
                                queries.map((query) => [subsetKey({ objectType, query }), query])
                            );
                            return yield* Effect.forEach(unique.values(), (query) => markQuery(tx, v, query));
                        });
                        const rootCache = new Map<string, Effect.Success<ReturnType<typeof markers>>>();
                        let count = 0;
                        let remaining = pressure ? yield* usage.total(tx) : 0;
                        for (const row of candidates) {
                            if (pressure && remaining <= target!) break;
                            const record = row.value;
                            const v = views.get(record.objectType)!;
                            const confirmed = yield* tx.get(v.base, record.key);
                            const baseline = yield* getBaseline(tx, v, record.key);
                            const inherited = v.inherited
                                ? yield* tx.get(v.inherited, record.key)
                                : undefined;
                            const value = confirmed ?? baseline;
                            if (!value && !inherited) {
                                yield* tx.delete(retention, row.key);
                                continue;
                            }
                            let marked = rootCache.get(record.objectType);
                            if (!marked) {
                                marked = yield* markers(record.objectType);
                                rootCache.set(record.objectType, marked);
                            }
                            const visible = yield* getVisible(tx, v, record.key);
                            const rooted =
                                value !== undefined &&
                                marked.some((mark) =>
                                    mark(
                                        { key: record.key, value },
                                        visible === undefined
                                            ? undefined
                                            : { key: record.key, value: visible },
                                        baseline === undefined
                                            ? undefined
                                            : { key: record.key, value: baseline }
                                    )
                                );
                            const actionProtected = (yield* tx.query(actionRows, {
                                where: eq(field("identity"), identity(record.objectType, record.key)),
                            })).some((root) => pending.has(root.value.action));
                            if (
                                rooted ||
                                actionProtected ||
                                (yield* tx.get(pins, identity(record.objectType, record.key))) ||
                                record.accessedAt > now - age
                            )
                                continue;
                            yield* retainRowBlobs(tx, record.objectType, record.key, undefined, "base");
                            if (confirmed !== undefined)
                                remaining -= usage.size(v.base as Table<unknown>, confirmed);
                            if (inherited !== undefined && v.inherited)
                                remaining -= usage.size(v.inherited as Table<unknown>, inherited);
                            yield* tx.delete(v.base, record.key);
                            if (v.inherited) yield* tx.delete(v.inherited, record.key);
                            if (
                                (yield* tx.get(
                                    deliveryRows,
                                    deliveryKey({
                                        kind: "base",
                                        objectType: record.objectType,
                                        key: record.key,
                                    })
                                )) ||
                                (v.inherited &&
                                    (yield* tx.get(
                                        deliveryRows,
                                        deliveryKey({
                                            kind: "override",
                                            objectType: record.objectType,
                                            key: record.key,
                                        })
                                    )))
                            ) {
                                const current = yield* position(tx);
                                yield* tx.put(metadata, "head", {
                                    ...current,
                                    deliveryResident: false,
                                    parentViewIdentity: undefined,
                                });
                            }
                            const head = yield* tx.get(imported, "head");
                            if (head) yield* tx.put(imported, "head", { ...head, resident: false });
                            yield* tx.delete(retention, row.key);
                            for (const cached of yield* tx.query(coverage, {
                                where: eq(field("subset", "objectType"), record.objectType),
                            }))
                                if (
                                    cached.value.rowKeys?.includes(record.key) ||
                                    (value !== undefined &&
                                        affectsCoverage(
                                            { key: record.key, value },
                                            cached.value.subset.query
                                        ))
                                )
                                    yield* tx.delete(coverage, cached.key);
                            count++;
                        }
                        const last = candidates.at(-1);
                        yield* tx.put(sweep, "position", {
                            reclaiming: pressure && remaining > target!,
                            after:
                                candidates.length < limit || !last
                                    ? undefined
                                    : { values: [last.value.accessedAt], key: last.key },
                        });
                        return count;
                    })
                )
            );
            if (removed) yield* notify;
            return removed;
        }),
    };
    if (options.startSync !== false && options.source) {
        yield* options.source.subscribe
            ? connectReplicaDelivery(service, options.source, { authentication })
            : connectReplicaParent(service, options.source, { authentication });
    } else if (options.startSync !== false) {
        if (adapter?.subscribeSelection)
            yield* connectReplicaDelivery(service, undefined, { authentication });
        const dataPollIntervalMs = options.pollIntervalMs ?? 5000;
        if (!Number.isFinite(dataPollIntervalMs) || dataPollIntervalMs < 100)
            return yield* fault("InvalidConfiguration", "Sync poll interval must be at least 100 ms.");
        yield* Effect.forkScoped(
            Effect.forever(
                Effect.gen(function* () {
                    yield* runStateSync().pipe(Effect.catch(() => Effect.void));
                    const now = yield* Clock.currentTimeMillis;
                    const delay =
                        syncRetry && syncRetry.at > now && replicationError?.recovery !== "stop"
                            ? Math.min(dataPollIntervalMs, Math.max(1, syncRetry.at - now))
                            : dataPollIntervalMs;
                    yield* options.pollIntervalMs !== undefined || (syncRetry && syncRetry.at > now)
                        ? Effect.raceFirst(Queue.take(queue), Effect.sleep(delay))
                        : Queue.take(queue);
                })
            )
        );
        yield* Effect.forkScoped(
            Effect.forever(
                Effect.gen(function* () {
                    yield* Queue.clear(outboxWake);
                    const result = yield* Effect.result(
                        Effect.annotateCurrentSpan("stage", "waiting-for-publication-gate").pipe(
                            Effect.andThen(
                                gate.withPermit(
                                    Effect.annotateCurrentSpan("stage", "processing").pipe(
                                        Effect.andThen(drainOutbox())
                                    )
                                )
                            ),
                            Effect.withSpan("Replica.outboxWork", { root: true })
                        )
                    );
                    if (result._tag === "Failure")
                        yield* Effect.logWarning("Outbox processing failed", {
                            kind: result.failure.kind,
                            retryable: result.failure.retryable,
                        });
                    const first = (yield* boundary(tables.read(pendingIn)))[0];
                    if (!first || first.state === "blocked" || !(yield* canSync)) {
                        return yield* Queue.take(outboxWake);
                    }
                    const now = yield* Clock.currentTimeMillis;
                    const retryAt =
                        first.nextAttemptAt !== undefined && first.nextAttemptAt > now
                            ? first.nextAttemptAt
                            : result._tag === "Failure" && result.failure.retryable
                              ? syncRetry?.error === result.failure
                                  ? syncRetry.at
                                  : now + Math.max(confirmationRetryDelayMs, result.failure.retryAfterMs ?? 0)
                              : result._tag === "Success" && result.success?.confirmationPending
                                ? now + confirmationRetryDelayMs
                                : undefined;
                    if (retryAt === undefined) return yield* Queue.take(outboxWake);
                    if (first.receipt && first.nextAttemptAt !== retryAt)
                        yield* boundary(
                            tables.transaction((tx) =>
                                Effect.gen(function* () {
                                    const current = yield* tx.get(outbox, first.invocation.id);
                                    if (
                                        current?.receipt &&
                                        JSON.stringify(current.receipt) === JSON.stringify(first.receipt)
                                    )
                                        yield* tx.put(outbox, first.invocation.id, {
                                            ...current,
                                            nextAttemptAt: retryAt,
                                        });
                                })
                            )
                        );
                    const delay = Math.max(1, retryAt - now);
                    yield* Effect.raceFirst(Queue.take(outboxWake), Effect.sleep(delay));
                })
            )
        );
        if (adapter?.changes?.watch)
            yield* Effect.forkScoped(
                superviseWatch({
                    acquire: () => adapter.changes!.watch!,
                    canRun: canSync,
                    authentication,
                    onValue: () => wakeState,
                    onError: service.reportWatchFailure,
                }).pipe(
                    Effect.withSpan("Replica.watchChanges", {
                        root: true,
                        attributes: { activity: "subscription" },
                    })
                )
            );
    }
    if (options.startSync !== false)
        yield* Effect.forkScoped(
            Effect.forever(
                maintain().pipe(
                    Effect.catch((error) =>
                        Effect.logWarning("Replica maintenance failed", { kind: error.kind })
                    ),
                    Effect.andThen(Effect.sleep(maintenanceIntervalMs))
                )
            )
        );
    yield* Stream.runForEach(connectivity.changes, () => localNotify.pipe(Effect.andThen(wake))).pipe(
        Effect.forkScoped
    );
    let initialConnectionState = true;
    if (connection)
        yield* Stream.runForEach(connection.changes, (state) =>
            Effect.gen(function* () {
                const activated =
                    !initialConnectionState &&
                    state.status === "active" &&
                    connection.state.status === "active";
                initialConnectionState = false;
                if (activated) {
                    authenticationGeneration++;
                    for (const demand of demands.values())
                        if (demand.loadFailure?.error.kind === "Unauthenticated") {
                            demand.loadFailure = undefined;
                            demand.revision++;
                        }
                }
                if (activated && replicationError?.kind === "Unauthenticated") {
                    syncRetry = undefined;
                    yield* service.reportReplicationFailure(undefined);
                }
                yield* localNotify;
                yield* wake;
            })
        ).pipe(Effect.forkScoped);
    if (options.startSync !== false && objectCacheGc) {
        const collect = service.collectGarbage(objectCacheGc).pipe(Effect.asVoid);
        yield* Effect.forkScoped(
            Effect.forever(
                Effect.raceFirst(Effect.sleep(objectCacheGc.sweepIntervalMs), Queue.take(cachePressure)).pipe(
                    Effect.andThen(collect),
                    Effect.catch((error) => Effect.logWarning("Replica GC pass failed", { kind: error.kind }))
                )
            )
        );
    }
    // Run before interrupting workers or releasing tables on a successful open.
    // The earlier guard also covers a partially failed acquisition.
    yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
            closed = true;
        })
    );
    return service;
});
