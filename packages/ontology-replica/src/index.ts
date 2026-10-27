import { isUnknownActionOutcome } from "@party-stack/ontology-backend";
export { makeCachedProxy } from "./proxy.js";
import { BackendError } from "@party-stack/ontology-backend";
import { clientRegistry } from "@party-stack/ontology-backend/clients";
import { stateIdentity } from "@party-stack/ontology-backend/protocol";
import { compileEffectSchemas } from "@party-stack/ontology-spec/effect";
import { resolveType } from "@party-stack/ontology-spec/utils";
import {
    evaluateQuery,
    field,
    eq,
    inArray,
    indexesForQuery,
    lte,
    OntologyStorageError,
    ConfigurationError,
} from "@party-stack/ontology-storage";
import {
    digestBytes,
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
import { Table } from "@party-stack/ontology-storage/tables";
import { Clock, Context, Effect, Exit, PubSub, Queue, Schema, Semaphore, Stream } from "effect";
import { hasWindow, isWholeCollection, primaryKeyLookup } from "./coverage.js";
import { cachedCopy, withCachedCopy, encryptedCacheCodec, preserveCachedCopies } from "./encryptedCache.js";
import { makeReplicaDiagnostics } from "./status.js";
import type { ReplicaLoad, ReplicaStatus } from "./status.js";
import type { Encrypted } from "@party-stack/ontology-spec/values";
export { ReplicaStatusSchema, makeReplicaMonitor } from "./status.js";
export type { ReplicaStatus, ReplicaLoad, ReplicaMonitor } from "./status.js";
import { connectReplicaParent } from "./parent.js";
import { affectsCoverage, markQuery, retentionQuery } from "./retention.js";
import type {
    ActionRequest,
    ActionReceipt,
    BackendSubset,
    OntologyBackendService,
} from "@party-stack/ontology-backend";
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
import type { Cursor, Index, Key, Query, Row } from "@party-stack/ontology-storage";
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
}
interface Coverage {
    complete?: boolean;
    subset: BackendSubset;
    snapshotCursor?: string;
    barrierCursor?: string;
    rowKeys?: readonly Key[];
    updatedAt: number;
}
interface Retention {
    objectType: string;
    key: Key;
    accessedAt: number;
}
export interface ActionWaitOptions {
    /** Accepted by the immediate parent, or committed upstream and reconciled locally. */
    readonly until?: "accepted" | "confirmed";
}
export interface ReplicaOutboxPolicy {
    /** Additional automatic attempts after the first dispatch. Defaults to 3. */
    readonly maxRetries?: number;
    /** Exponential retry delay, capped at 60 seconds. Defaults to 1 second. */
    readonly retryDelayMs?: number;
    /** Abandon pending intent on terminal failure, including unknown remote outcomes. */
    readonly failureStrategy?: "pause" | "discard-all";
}
export interface ReplicaService extends OwnedReadTransaction {
    readonly ir: OntologyIR;
    readonly mode: "adapter" | "protocol";
    /** Read-only diagnostics; inspecting never acquires remote demand. */
    readonly status: Effect.Effect<ReplicaStatus, BackendError>;
    readonly statuses: Stream.Stream<ReplicaStatus, BackendError>;
    /** Stable identity of the state this Replica can expose to its own consumers. */
    readonly sourceId: string;
    /** Reads the confirmed baseline without optimistic overrides. Neither read path acquires remote demand. */
    readonly confirmed: OwnedReadTransaction;
    readonly snapshotSubset: (
        subset: BackendSubset,
        confirmed?: boolean
    ) => Effect.Effect<import("@party-stack/ontology-backend").BackendSnapshot, BackendError>;
    /** Private device-encrypted copies, stored on existing base rows. Never creates or retains rows. */
    readonly encryptedCache: {
        readonly get: (value: Encrypted) => Effect.Effect<Encrypted | undefined, BackendError>;
        readonly put: (value: Encrypted, local: Encrypted) => Effect.Effect<void, BackendError>;
    };
    readonly changes: Stream.Stream<void>;
    /** Acquires the subscription now, before a caller reads its initial snapshot. */
    readonly subscribeChanges: Effect.Effect<Stream.Stream<void>, BackendError, import("effect").Scope.Scope>;
    readonly pending: Effect.Effect<readonly PendingAction[], BackendError>;
    /** Observed parent actions plus the local tail, with forwarding stage captured in the same read.
     * Parent visibility follows retainActions leases. Forwarding is not upstream execution. */
    readonly pendingActions: Effect.Effect<
        readonly (PendingAction & { readonly forwarding: boolean })[],
        BackendError
    >;
    readonly snapshotState: Effect.Effect<ReplicaStateSnapshot, BackendError>;
    readonly openClient: (resume?: ClientToken) => Effect.Effect<ClientLease, BackendError>;
    readonly readClient: (
        session: ClientSession,
        view?: ClientView
    ) => Effect.Effect<ClientState, BackendError>;
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
        requestedActionIds?: readonly string[]
    ) => Effect.Effect<void, BackendError>;
    readonly refreshParent: (source: OntologySource) => Effect.Effect<void, BackendError>;
    /** Refresh observed state and forward only locally owned actions, in order. */
    readonly syncParent: (source: OntologySource) => Effect.Effect<void, BackendError>;
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
    readonly demand: (
        subset: BackendSubset
    ) => Effect.Effect<void, BackendError, import("effect").Scope.Scope>;
    readonly retainLocal: (
        objectType: string,
        query?: Query
    ) => Effect.Effect<void, BackendError, import("effect").Scope.Scope>;
    /** Explicit privileged action inspection; omitted IDs request the retained action view. */
    readonly retainActions: (
        ids?: readonly string[]
    ) => Effect.Effect<void, BackendError, import("effect").Scope.Scope>;
    readonly pin: (objectType: string, key: Key, pinned: boolean) => Effect.Effect<void, BackendError>;
    readonly syncOnce: Effect.Effect<void, BackendError>;
    readonly invalidate: (objectTypes?: readonly string[]) => Effect.Effect<void, BackendError>;
    readonly ensureIndex: (objectType: string, index: Index) => Effect.Effect<void, BackendError>;
    readonly collectGarbage: (options?: {
        limit?: number;
        olderThanMs?: number;
    }) => Effect.Effect<number, BackendError>;
    readonly wake: Effect.Effect<void>;
}
export class Replica extends Context.Service<Replica, ReplicaService>()(
    "@party-stack/ontology-replica/Replica"
) {}
interface ReplicaCommonOptions {
    readonly namespace: string;
    readonly ir: OntologyIR;
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
    readonly online?: Effect.Effect<boolean>;
    readonly connectivity?: Stream.Stream<boolean>;
    /** Multi-context deployments supply their existing leader lease here. */
    readonly startSync?: boolean;
    readonly clients?: ClientPolicy;
    readonly resultRetentionMs?: number;
    readonly pollIntervalMs?: number;
    readonly outbox?: ReplicaOutboxPolicy;
    /** Replica cache eviction only; owned storage is never collected by this policy. */
    readonly gc?:
        | false
        | { readonly intervalMs?: number; readonly olderThanMs?: number; readonly limit?: number };
    readonly publish?: Effect.Effect<void>;
    readonly externalChanges?: Stream.Stream<void>;
    readonly registerOwner?: (
        owner: string
    ) => Effect.Effect<void, BackendError, import("effect").Scope.Scope>;
    readonly isOwnerAlive?: (owner: string) => Effect.Effect<boolean, BackendError>;
}
/** Use a provider/owned backend binding or a protocol source, never both.
 * Protocol attachment services currently delegate to the parent.
 */
export type ReplicaOptions = ReplicaCommonOptions &
    (
        | { readonly backend: OntologyBackendService; readonly source?: never }
        | { readonly source: OntologySource; readonly backend?: never }
    );
const fault = (kind: BackendError["kind"], message: string, cause?: unknown) =>
    new BackendError({ operation: "replica", kind, message, retryable: kind === "Unavailable", cause });
const boundary = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    work.pipe(
        Effect.mapError((cause) =>
            cause instanceof BackendError ? cause : fault("Unavailable", "Replica storage failed.", cause)
        )
    );
const identity = (type: string, key: Key) => JSON.stringify([type, key]);
const subsetKey = (subset: BackendSubset) =>
    Table.make<BackendSubset>({ name: "subset-identity" }).encode(subset);

// Keep a bounded identity witness, not another retained copy of the parent's rows.
const snapshotDigest = Effect.fnUntraced(function* (snapshot: ReplicaStateSnapshot) {
    const encoded = yield* Effect.try({
        try: () => new TextEncoder().encode(stateIdentity(snapshot)),
        catch: (cause) => fault("ValidationFailed", "Invalid parent state.", cause),
    });
    return yield* boundary(digestBytes({ type: "application/json", stream: Stream.make(encoded) }));
});

/** A scoped persistent Replica. Its replay capability cannot reach the backend. */
export const makeReplica = Effect.fn("Replica.make")(function* (options: ReplicaOptions) {
    const maxRetries = options.outbox?.maxRetries ?? 3;
    const retryDelayMs = options.outbox?.retryDelayMs ?? 1_000;
    if (
        !Number.isSafeInteger(maxRetries) ||
        maxRetries < 0 ||
        !Number.isFinite(retryDelayMs) ||
        retryDelayMs < 0 ||
        retryDelayMs > 60_000
    )
        return yield* fault("ValidationFailed", "Invalid outbox retry policy.");
    if (
        options.resultRetentionMs !== undefined &&
        (options.resultRetentionMs <= 0 || Number.isNaN(options.resultRetentionMs))
    )
        return yield* fault("ValidationFailed", "Result retention must be positive.");
    const adapter = options.backend;
    const sourceId = options.source?.sourceId ?? adapter!.sourceId;
    const backendEffect = adapter
        ? Effect.succeed(adapter)
        : Effect.fail(fault("NotImplemented", "This Replica receives state through its protocol source."));
    const name = (part: string) => JSON.stringify(["replica", options.namespace, part]);
    const stateHead = Table.make<{ sourceId: string; revision: number }>({ name: name("state-head") });
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
    const tables: TablesService = {
        ...options.tables,
        transaction: (body) =>
            options.tables.transaction((tx) =>
                Effect.gen(function* () {
                    const result = yield* body(tx);
                    const head = yield* tx.get(stateHead, "head");
                    if (head && !Number.isSafeInteger(head.revision + 1))
                        return yield* new OntologyStorageError({
                            operation: "replica.revision",
                            reason: new ConfigurationError({ message: "Replica state revision exhausted." }),
                        });
                    yield* tx.put(stateHead, "head", {
                        sourceId: head?.sourceId ?? crypto.randomUUID(),
                        revision: (head?.revision ?? 0) + 1,
                    });
                    return result;
                })
            ),
    };
    if (options.source && options.blobs)
        return yield* fault(
            "NotImplemented",
            "Protocol attachment services currently delegate to the parent."
        );
    const gc =
        options.gc === false
            ? undefined
            : {
                  intervalMs: options.gc?.intervalMs ?? 60_000,
                  olderThanMs: options.gc?.olderThanMs ?? 24 * 60 * 60 * 1000,
                  limit: options.gc?.limit ?? 100,
              };
    if (
        gc &&
        (!Number.isFinite(gc.intervalMs) ||
            gc.intervalMs < 10 ||
            !Number.isFinite(gc.olderThanMs) ||
            gc.olderThanMs < 0 ||
            !Number.isSafeInteger(gc.limit) ||
            gc.limit < 1 ||
            gc.limit > 10_000)
    )
        return yield* fault("ValidationFailed", "Invalid automatic GC policy.");
    if (Boolean(options.registerOwner) !== Boolean(options.isOwnerAlive))
        return yield* fault(
            "ValidationFailed",
            "Owner registration and liveness checks must be supplied together."
        );
    const schemas = yield* Effect.try({
        try: () => compileEffectSchemas(options.ir),
        catch: (cause) => fault("ValidationFailed", "Invalid ontology definition.", cause),
    });
    const views = new Map<string, Overlay<ObjectValue>>();
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
        const inherited = options.source
            ? overlay(base, { name: name(`parent-overlay:${type.name}`) }).overrides
            : undefined;
        views.set(type.name, overlay(base, { name: name(`overlay:${type.name}`), inherited }));
    }
    const blobGroup = (type: string, kind: "base" | "overlay") =>
        JSON.stringify(["replica-row", options.namespace, kind, type]);
    const retainRowBlobs = (
        tx: Transaction,
        type: string,
        key: Key,
        value: ObjectValue | undefined,
        kind: "base" | "overlay"
    ) => {
        if (!options.blobs) return Effect.void;
        const group = blobGroup(type, kind);
        const owner = JSON.stringify([group, key]);
        return value === undefined
            ? options.blobs.in(tx).release(owner)
            : options.blobs.in(tx).retain(
                  owner,
                  collectObjectAttachments(options.ir, type, value).map((entry) => entry.attachment.id),
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
        tx.loadSubset(outbox, {
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
    const actionQueries = Table.make<{ action: string; subset: BackendSubset }>({
        name: name("action-queries"),
    });
    const sweep = Table.make<{ after?: Cursor }>({ name: name("sweep") });
    const rootOwner = crypto.randomUUID();
    if (options.registerOwner) yield* options.registerOwner(rootOwner);
    const rootCounts = new Map<string, number>();
    const rootGate = yield* Semaphore.make(1);
    const pins = Table.make<{ objectType: string; key: Key }>({ name: name("pins") });
    const signature = JSON.stringify(options.ir);
    const events = yield* PubSub.sliding<void>(1);
    const queue = yield* Queue.sliding<void>(1);
    yield* Effect.addFinalizer(() => PubSub.shutdown(events));
    yield* Effect.addFinalizer(() => Queue.shutdown(queue).pipe(Effect.asVoid));
    const gate = yield* Semaphore.make(1);
    const demands = new Map<
        string,
        {
            subset: BackendSubset;
            count: number;
            revision: number;
            installed: number;
            watchers: number;
            coveredBy?: BackendSubset;
            pollIntervalMs?: number;
            pollDisabled?: boolean;
            coverageProof?: ReplicaStatus["demands"][number]["coverageProof"];
        }
    >();
    const actionInterests = new Map<string, readonly string[] | undefined>();
    let closed = false;
    const open = Effect.suspend(() =>
        closed ? Effect.fail(fault("ValidationFailed", "Replica scope is closed.")) : Effect.void
    );
    yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
            closed = true;
        })
    );
    const view = (type: string) => {
        const found = views.get(type);
        return found
            ? Effect.succeed(found)
            : Effect.fail(fault("ValidationFailed", `Unknown object type ${JSON.stringify(type)}.`));
    };
    const putBase = Effect.fnUntraced(function* (
        tx: Transaction,
        type: string,
        key: Key,
        value: ObjectValue
    ) {
        const v = yield* view(type);
        const properties = encryptedProperties.get(type)!;
        const previous = properties.length ? yield* tx.get(v.base, key) : undefined;
        yield* tx.put(v.base, key, preserveCachedCopies(previous, value, properties));
    });
    const diagnostics = yield* makeReplicaDiagnostics();
    const localNotify = PubSub.publish(events, undefined).pipe(
        Effect.andThen(diagnostics.changed),
        Effect.asVoid
    );
    const notify = options.publish ? localNotify.pipe(Effect.andThen(options.publish)) : localNotify;
    const wake = Effect.suspend(() =>
        closed ? Effect.void : Queue.offer(queue, undefined).pipe(Effect.asVoid)
    );
    const access = <A, E, R>(work: Effect.Effect<A, E, R>) => open.pipe(Effect.andThen(boundary(work)));
    const retain = (objectType: string, kind: "remote" | "reader", key: string, subset?: BackendSubset) =>
        Effect.acquireRelease(
            rootGate.withPermits(1)(
                boundary(
                    Effect.gen(function* () {
                        yield* open;
                        yield* view(objectType);
                        if (subset)
                            yield* Effect.try({
                                try: () => evaluateQuery([], subset.query ?? {}),
                                catch: (cause) =>
                                    fault("ValidationFailed", "Invalid retention query.", cause),
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
                                    revision: 1,
                                    installed: 0,
                                    watchers: 0,
                                });
                            yield* wake;
                        }
                        yield* diagnostics.changed;
                        if (options.source) yield* localNotify;
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
                                else demands.delete(key);
                            }
                            yield* diagnostics.changed;
                            if (options.source) yield* localNotify;
                        })
                    )
                    .pipe(Effect.orDie)
        ).pipe(Effect.asVoid);

    const pendingIn = (tx: ReadTransaction) =>
        tx
            .loadSubset(outbox, { orderBy: [{ field: field("sequence") }] })
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
            if (stored && stored.signature !== signature)
                return yield* fault(
                    "SchemaMismatch",
                    "Replica definition changed; migrate or reset this namespace explicitly."
                );
            return (
                stored ?? {
                    sequence: 0,
                    source: sourceId,
                    signature,
                    ...(options.source ? { mode: "parent" as const } : {}),
                }
            );
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
                    return yield* confirmed ? tx.loadSubset(v.base, query) : loadVisible(tx, v, query);
                })
            ),
    });
    const clearActionRoots = Effect.fnUntraced(function* (tx: Transaction, id: string) {
        for (const row of yield* tx.loadSubset(actionRows, { where: eq(field("action"), id) }))
            yield* tx.delete(actionRows, row.key);
        for (const row of yield* tx.loadSubset(actionQueries, { where: eq(field("action"), id) }))
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
        const queries = new Map<string, BackendSubset>();
        const rememberKey = (objectType: string, key: Key) =>
            keys.set(identity(objectType, key), { objectType, key });
        let active = true;
        const guard = <A, E>(effect: Effect.Effect<A, E>) =>
            Effect.suspend<A, E | BackendError, never>(() =>
                active ? effect : Effect.fail(fault("ValidationFailed", "Replay transaction is closed."))
            );
        const read = reader(tx, false);
        const local: OwnedTransaction = {
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
                            catch: (cause) => fault("ValidationFailed", "Invalid replay query.", cause),
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
                            catch: () =>
                                fault("ValidationFailed", "Mutation does not match the object definition."),
                        });
                        const key = copy[definitions.get(type)!.primaryKey];
                        if (typeof key !== "string" && typeof key !== "number")
                            return yield* fault("ValidationFailed", "Mutation has an invalid primary key.");
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
        for (const row of yield* tx.loadSubset(coverage)) yield* tx.delete(coverage, row.key);
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
    const readOutside = (confirmed: boolean): OwnedReadTransaction => ({
        get: (type, key) =>
            boundary(
                Effect.andThen(
                    open,
                    tables.read((tx) => reader(tx, confirmed).get(type, key))
                )
            ),
        loadSubset: (type, query) =>
            boundary(
                Effect.andThen(
                    open,
                    tables.read((tx) => reader(tx, confirmed).loadSubset(type, query))
                )
            ),
    });
    const loadSubset = (subset: BackendSubset, reason: ReplicaLoad["reason"]) =>
        diagnostics.load(
            { operation: "loadSubset", reason, subset },
            adapter!.loadSubset(subset),
            (snapshot) => ({
                rows: snapshot.rows.length,
                fetchedRows: snapshot.fetchedRows,
                pushdown: snapshot.pushdown,
                complete: snapshot.complete,
            })
        );
    const prepareSnapshot = Effect.fn("Replica.loadSnapshot")(function* (
        subset: BackendSubset,
        keys?: readonly Key[],
        requireComplete = false,
        reason: ReplicaLoad["reason"] = "demand"
    ) {
        const backend = yield* backendEffect;
        yield* Effect.annotateCurrentSpan("objectType", subset.objectType);
        const snapshot = yield* loadSubset(subset, reason);
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
                    return yield* fault("ValidationFailed", "Action read-back returned an unrequested key.");
                repaired.delete(row.key);
            }
        } else if (!backend.changes && snapshot.complete && !isWholeCollection(subset.query)) {
            const returned = new Set(snapshot.rows.map((row) => row.key));
            const candidates = yield* boundary(tables.loadSubset(v.base, { where: subset.query?.where }));
            const missing = candidates.filter((row) => !returned.has(row.key)).map((row) => row.key);
            for (let offset = 0; offset < missing.length; offset += 128) {
                const keys = missing.slice(offset, offset + 128);
                const repair = yield* loadSubset(
                    {
                        objectType: subset.objectType,
                        query: {
                            where: inArray(field(definitions.get(subset.objectType)!.primaryKey), keys),
                        },
                    },
                    "repair"
                );
                if (!repair.complete)
                    return yield* fault("Unavailable", "Filtered snapshot repair was incomplete.");
                for (const key of keys) repaired.set(key, undefined);
                for (const row of repair.rows) {
                    if (!keys.includes(row.key))
                        return yield* fault(
                            "ValidationFailed",
                            "Snapshot repair returned an unrequested key."
                        );
                    repaired.set(row.key, row.value);
                }
            }
        }
        const now = yield* Clock.currentTimeMillis;
        return (tx: Transaction) =>
            Effect.gen(function* () {
                const incoming = [
                    ...snapshot.rows,
                    ...[...repaired].flatMap(([key, value]) => (value === undefined ? [] : [{ key, value }])),
                ];
                const preserved = new Map<Key, ObjectValue>();
                const properties = encryptedProperties.get(subset.objectType)!;
                if (properties.length)
                    for (const row of incoming)
                        preserved.set(
                            row.key,
                            preserveCachedCopies(yield* tx.get(v.base, row.key), row.value, properties)
                        );
                // Only an unfiltered complete snapshot can prove arbitrary cached keys were removed.
                if (snapshot.complete && isWholeCollection(subset.query)) {
                    yield* clearRowBlobs(tx, subset.objectType, "base");
                    yield* tx.clear(v.base);
                }
                for (const [key, value] of repaired) {
                    if (value !== undefined) continue;
                    yield* retainRowBlobs(tx, subset.objectType, key, undefined, "base");
                    yield* tx.delete(v.base, key);
                    yield* tx.delete(retention, identity(subset.objectType, key));
                }
                for (const row of incoming) {
                    if (row.value[definitions.get(subset.objectType)!.primaryKey] !== row.key)
                        return yield* fault("ValidationFailed", "Snapshot key does not match its row.");
                    yield* retainRowBlobs(tx, subset.objectType, row.key, row.value, "base");
                    yield* tx.put(v.base, row.key, preserved.get(row.key) ?? row.value);
                    yield* tx.put(retention, identity(subset.objectType, row.key), {
                        objectType: subset.objectType,
                        key: row.key,
                        accessedAt: now,
                    });
                }
                yield* tx.put(coverage, subsetKey(subset), {
                    subset,
                    complete: snapshot.complete,
                    snapshotCursor: snapshot.cursor,
                    barrierCursor:
                        snapshot.cursor !== (yield* position(tx)).cursor ? snapshot.cursor : undefined,
                    rowKeys: snapshot.rows.map((row) => row.key),
                    updatedAt: now,
                });
            });
    });
    const installSnapshot = Effect.fn("Replica.installSnapshot")(function* (
        subset: BackendSubset,
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
                        const barriers = (yield* tx.loadSubset(coverage)).filter(
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
                                            "ValidationFailed",
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
            if (!page.hasMore) break;
            if (page.cursor === before.cursor)
                return yield* fault("HistoryExpired", "Backend returned a non-advancing change page.");
        }
    });
    const recoverHistory = Effect.fn("Replica.recoverHistory")(function* () {
        const backend = yield* backendEffect;
        const first = options.ir.objectTypes[0];
        if (!first) return;
        // Establish the new starting cursor before loading selected snapshots. Their
        // existing per-subset barriers prevent catch-up from overwriting newer data.
        const anchor = yield* backend.loadSubset({ objectType: first.name, query: { limit: 0 } });
        if (!anchor.cursor)
            return yield* fault("NotImplemented", "History recovery requires coordinated snapshot cursors.");
        const requests = new Map<string, BackendSubset>();
        for (const demand of demands.values()) requests.set(subsetKey(demand.subset), demand.subset);
        for (const [type, store] of views) {
            const keys = (yield* boundary(tables.loadSubset(store.base))).map((row) => row.key);
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
    const pull = () =>
        adapter?.changes
            ? pullJournal().pipe(
                  Effect.catch((error) =>
                      error.kind === "HistoryExpired" ? recoverHistory() : Effect.fail(error)
                  )
              )
            : Effect.void;
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
                    return yield* fault("ValidationFailed", "Receipt named an unknown object type.");
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
    const bindReceiptBlobs = (tx: Transaction, receipt: ActionReceipt) =>
        options.blobs
            ? Effect.forEach(
                  receipt.attachmentIdMappings ?? [],
                  (mapping) => options.blobs!.in(tx).bindRemoteId(mapping.localId, mapping.remoteId),
                  { discard: true }
              )
            : Effect.void;
    const collectResults = access(
        tables.transaction((tx) =>
            Effect.gen(function* () {
                const age = options.resultRetentionMs ?? 7 * 24 * 60 * 60 * 1000;
                if (!Number.isFinite(age)) return;
                const now = yield* Clock.currentTimeMillis;
                for (const row of yield* tx.loadSubset(completed, {
                    where: lte(field("completedAt"), now - age),
                    limit: 100,
                })) {
                    // A child may still be awaiting the result. Its durable session/result window
                    // is finite; never remove the parent's own unresolved outbox.
                    yield* tx.delete(completed, row.key);
                }
                const protectedHints = (yield* tx.loadSubset(outbox)).length;
                for (const row of yield* tx.loadSubset(journalReceipts, {
                    where: lte(field("observedAt"), now - age),
                    limit: 100 + protectedHints,
                }))
                    if (!(yield* tx.get(outbox, row.value.operationId)))
                        yield* tx.delete(journalReceipts, row.key);
                for (const row of yield* tx.loadSubset(coverage, {
                    where: lte(field("updatedAt"), now - age),
                    // Active coverage may be old when auto-refresh is disabled. Scan past
                    // at most one protected record per active demand to avoid starving eviction.
                    limit: 100 + demands.size,
                }))
                    if (!demands.has(subsetKey(row.value.subset))) yield* tx.delete(coverage, row.key);
            })
        )
    );
    const saveReceipt = (entry: PendingAction, receipt: ActionReceipt, bindings: boolean) =>
        tables.transaction((tx) =>
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
                if (bindings) yield* bindReceiptBlobs(tx, receipt);
            })
        );
    const sync = Effect.fn("Replica.sync", { root: true })(function* () {
        yield* open;
        yield* service.collectClientGarbage;
        yield* collectResults;
        const backend = yield* backendEffect;
        const online = yield* options.online ?? Effect.succeed(true);
        yield* diagnostics.setOnline(online);
        if (!online) return;
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
                yield* boundary(tables.transaction((tx) => bindReceiptBlobs(tx, entry.receipt!)));
                yield* options.onReceipt?.(entry.receipt) ?? Effect.void;
            }
        yield* pull();
        // On restart, settle known remote commits before refreshing source snapshots.
        // Otherwise those snapshots can contain our edit while its optimistic
        // mutator is still pending, briefly applying the same edit twice.
        for (;;) {
            const entry = (yield* boundary(tables.read(pendingIn)))[0];
            if (
                !entry?.receipt ||
                entry.receipt.outcome !== "committed" ||
                (entry.receipt.cursor && backend.changes)
            )
                break;
            yield* confirmReceipt(entry, entry.receipt);
        }
        const head = yield* boundary(tables.read(position));
        const covered = Effect.fnUntraced(function* (subset: BackendSubset) {
            const records = yield* boundary(
                tables.loadSubset(coverage, {
                    where: eq(field("subset", "objectType"), subset.objectType),
                })
            );
            const key = primaryKeyLookup(subset.query, definitions.get(subset.objectType)!.primaryKey);
            const present =
                key !== undefined &&
                (yield* boundary(tables.get((yield* view(subset.objectType)).base, key))) !== undefined;
            for (const { value: record } of records) {
                const live = demands.get(subsetKey(record.subset));
                const maintained = backend.changes
                    ? record.snapshotCursor !== undefined && record.barrierCursor === undefined
                    : live && live.watchers > 0 && live.installed === live.revision;
                if (!maintained) continue;
                const proof = (reason: "collection" | "query" | "primary-key") => ({
                    subset: record.subset,
                    proof: {
                        reason,
                        maintainedBy: backend.changes
                            ? ("journal" as const)
                            : live?.pollIntervalMs !== undefined
                              ? ("poll" as const)
                              : ("watch" as const),
                        pollIntervalMs: backend.changes ? undefined : live?.pollIntervalMs,
                    },
                });
                if (record.complete && isWholeCollection(record.subset.query)) return proof("collection");
                if (
                    record.complete &&
                    subsetKey(record.subset) === subsetKey(subset) &&
                    (!backend.changes || !hasWindow(subset.query) || record.snapshotCursor === head.cursor)
                )
                    return proof("query");
                if (
                    record.complete &&
                    key !== undefined &&
                    primaryKeyLookup(record.subset.query, definitions.get(subset.objectType)!.primaryKey) ===
                        key
                )
                    return proof("query");
                if (key !== undefined && present && record.rowKeys?.includes(key))
                    return proof("primary-key");
            }
            return undefined;
        });
        // Snapshot refresh follows journal catch-up, so historical commits cannot replace newer snapshots.
        for (const demand of demands.values()) {
            const cached = yield* boundary(tables.get(coverage, subsetKey(demand.subset)));
            const coveringSubset = yield* covered(demand.subset);
            if (coveringSubset) {
                demand.installed = demand.revision;
                demand.coveredBy = coveringSubset.subset;
                demand.coverageProof = coveringSubset.proof;
                continue;
            }
            demand.coveredBy = undefined;
            demand.coverageProof = undefined;
            if (
                (demand.watchers || demand.pollDisabled) &&
                cached?.complete &&
                demand.installed === demand.revision
            )
                continue;
            const revision = demand.revision;
            yield* installSnapshot(demand.subset, demand.installed === 0 ? "demand" : "refresh");
            demand.installed = revision;
        }
        for (;;) {
            const entries = yield* boundary(tables.read(pendingIn));
            const first = entries[0];
            if (!first || first.state === "blocked") return;
            if (first.nextAttemptAt !== undefined && first.nextAttemptAt > (yield* Clock.currentTimeMillis))
                return;
            let head: PendingAction = first;
            let receipt = head.receipt;
            if (head.state === "acknowledged" && !receipt)
                return yield* fault("ValidationFailed", "Acknowledged invocation is missing its receipt.");
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
                    backend.applyAction(head.invocation).pipe(Effect.withSpan("Replica.dispatch"))
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
                if (receipt.operationId !== head.invocation.id)
                    return yield* fault(
                        "ValidationFailed",
                        "Backend returned a receipt for another invocation."
                    );
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
            yield* boundary(tables.transaction((tx) => bindReceiptBlobs(tx, receipt!)));
            yield* options.onReceipt?.(receipt) ?? Effect.void;
            if (receipt.cursor && backend.changes) {
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
                if (remains) return; // The journal has not published this receipt yet.
                yield* notify;
            } else if (receipt.outcome === "committed") {
                yield* confirmReceipt(head, receipt);
            } else return; // Keep accepted operations durable until an authoritative acknowledgement arrives.
        }
    });
    const parentStateIn = Effect.fnUntraced(function* (tx: ReadTransaction) {
        const head = yield* tx.get(imported, "head");
        if (!head) return;
        const objects: Array<ReplicaStateSnapshot["objects"][number]> = [];
        for (const [objectType, v] of views)
            objects.push({
                objectType,
                base: yield* tx.loadSubset(v.base),
                overrides: v.inherited ? yield* tx.loadSubset(v.inherited) : [],
            });
        const { digest: _digest, resident: _resident, ...publicHead } = head;
        return {
            ...publicHead,
            objects,
            pending: (yield* tx.loadSubset(importedPending)).map((row) => row.value),
            completed: (yield* tx.loadSubset(importedCompleted)).map((row) => row.value),
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
                catch: (cause) => fault("ValidationFailed", "Invalid selected query.", cause),
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
            const base = yield* tx.loadSubset(baseline);
            let overrides: readonly Row<Override<ObjectValue>>[];
            if (!parent) overrides = yield* tx.loadSubset(v.overrides);
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
            table: import("@party-stack/ontology-storage/tables").Table<PendingAction>
        ) {
            if (!selected || selected.selection.inspectActions)
                return (yield* tx.loadSubset(table)).map((row) => row.value);
            const entries: PendingAction[] = [];
            for (const id of selected.selection.actionIds) {
                const entry = yield* tx.get(table, id);
                if (entry) entries.push(entry);
            }
            return entries;
        });
        const pending = new Map(
            (parent ? yield* actions(importedPending) : []).map((entry) => [entry.invocation.id, entry])
        );
        for (const entry of yield* actions(outbox))
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
    const syncOnce = options.source
        ? Effect.suspend(() => service.syncParent(options.source!))
        : gate.withPermits(1)(diagnostics.sync(sync()));
    const ownSourceId = (yield* boundary(tables.get(stateHead, "head")))!.sourceId;
    const clients = clientRegistry(options.namespace, ownSourceId, options.clients);
    yield* boundary(options.tables.transaction(clients.initialize));
    let parentSession: ClientLease | undefined;
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
    });
    const requestedView = Effect.fnUntraced(function* (): Effect.fn.Return<ClientView, BackendError> {
        return yield* access(
            options.tables.transaction((tx) =>
                Effect.gen(function* () {
                    const subsets = new Map<string, BackendSubset>();
                    const include = (subset: BackendSubset) => subsets.set(subsetKey(subset), subset);
                    for (const row of yield* tx.loadSubset(roots, { where: eq(field("owner"), rootOwner) }))
                        include({ objectType: row.value.objectType, query: retentionQuery(row.value.query) });
                    for (const row of yield* tx.loadSubset(pins))
                        include({
                            objectType: row.value.objectType,
                            query: {
                                where: eq(
                                    field(definitions.get(row.value.objectType)!.primaryKey),
                                    row.value.key
                                ),
                            },
                        });
                    const pending = [
                        ...(yield* pendingIn(tx)),
                        ...(yield* acceptedIn(tx)).map((row) => row.value),
                    ];
                    for (const entry of pending) {
                        for (const row of yield* tx.loadSubset(actionRows, {
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
                        for (const row of yield* tx.loadSubset(actionQueries, {
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
                    const selection = {
                        subsets: [...subsets.entries()]
                            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                            .map(([, subset]) => subset),
                        actionIds: [...actionIds].sort(),
                        ...(inspectActions ? { inspectActions: true } : {}),
                    };
                    const identity = Table.make({ name: "view-identity" }).encode(selection);
                    const current = yield* position(tx);
                    const generation =
                        (current.parentViewGeneration ?? 0) +
                        (current.parentViewIdentity === identity ? 0 : 1);
                    if (!Number.isSafeInteger(generation) || generation < 1)
                        return yield* fault("ValidationFailed", "Selected view generation exhausted.");
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
        yield* service.receiveParentState(batch.state, selection?.actionIds);
        yield* source.acknowledge(
            session,
            batch.state.revision,
            batch.client.deliveredThrough,
            batch.state.view?.generation
        );
    });
    const service: ReplicaService = {
        snapshotSubset: (subset, confirmed = true) =>
            access(
                tables.read((tx) =>
                    Effect.gen(function* () {
                        const demand = demands.get(subsetKey(subset));
                        const proof = yield* tx.get(coverage, subsetKey(demand?.coveredBy ?? subset));
                        return {
                            rows: yield* reader(tx, confirmed).loadSubset(subset.objectType, subset.query),
                            complete: proof?.complete === true,
                            cursor: (yield* position(tx)).cursor,
                        };
                    })
                )
            ),
        ir: options.ir,
        mode: options.source ? "protocol" : "adapter",
        status: Effect.gen(function* () {
            const pending = yield* access(tables.read(pendingIn));
            const outbox: Record<string, number> = {};
            for (const entry of pending) outbox[entry.state] = (outbox[entry.state] ?? 0) + 1;
            return {
                sourceId: ownSourceId,
                upstreamId: sourceId,
                mode: options.source ? ("protocol" as const) : ("adapter" as const),
                ...diagnostics.snapshot(),
                outbox,
                demands: [...demands.values()].map((demand) => ({
                    ...demand.subset,
                    references: demand.count,
                    watchers: demand.watchers,
                    revision: demand.revision,
                    installed: demand.installed,
                    coveredBy: demand.installed === demand.revision ? demand.coveredBy : undefined,
                    coverageProof: demand.installed === demand.revision ? demand.coverageProof : undefined,
                })),
            };
        }),
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
                        (yield* tx.loadSubset(importedPending)).map((row) => [
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
                        return { state, client };
                    })
                )
            ),
        submitClient: Effect.fn("Replica.submitClient")(function* (request: ClientSubmission) {
            yield* open;
            if (!request.invocation.id || request.invocation.attachmentUploads?.length)
                return yield* fault(
                    "ValidationFailed",
                    "Protocol submissions require an invocation ID and staged attachment handles."
                );
            if (
                request.view &&
                !request.view.selection.inspectActions &&
                !request.view.selection.actionIds.includes(request.invocation.id)
            )
                return yield* fault(
                    "ValidationFailed",
                    "The submission view must include its action outcome."
                );
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
                                catch: (cause) => fault("ValidationFailed", "Invalid selected query.", cause),
                            });
                        }
                        return yield* clients.admit(tx, request.session, request.sequence, fingerprint, () =>
                            enqueueIn(tx, request.invocation, { optimistic: request.optimistic })
                        );
                    })
                )
            );
            yield* notify;
            yield* wake;
            return yield* service.readClient(request.session, request.view);
        }),
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
            requestedActionIds?: readonly string[]
        ) {
            yield* open;
            if (!options.source)
                return yield* fault("NotImplemented", "This Replica uses the backend adapter interface.");
            if (snapshot.sourceId !== sourceId)
                return yield* fault("SourceMismatch", "Parent source changed; reset explicitly.");
            if (snapshot.definition !== signature)
                return yield* fault(
                    "SchemaMismatch",
                    "Parent definition changed; migrate or reset explicitly."
                );
            if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1)
                return yield* fault("ValidationFailed", "Invalid parent revision.");
            if (
                snapshot.view &&
                (!Number.isSafeInteger(snapshot.view.generation) || snapshot.view.generation < 1)
            )
                return yield* fault("ValidationFailed", "Invalid parent view generation.");
            const digest = yield* snapshotDigest(snapshot);
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
                                return false;
                            }
                        }
                        const objectTypes = new Set(snapshot.objects.map((object) => object.objectType));
                        if (objectTypes.size !== views.size || snapshot.objects.length !== views.size)
                            return yield* fault(
                                "ValidationFailed",
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
                            yield* tx.clear(v.base);
                            yield* tx.clear(inherited);
                            for (const row of object.base) {
                                if (row.value[primaryKey] !== row.key)
                                    return yield* fault(
                                        "ValidationFailed",
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
                                            "ValidationFailed",
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
                        const known = new Map(
                            [...snapshot.pending, ...snapshot.completed].map((entry) => [
                                entry.invocation.id,
                                entry,
                            ])
                        );
                        for (const entry of yield* pendingIn(tx)) {
                            const observed = known.get(entry.invocation.id);
                            if (!observed) continue;
                            const identity = Table.make<ActionRequest>({ name: "invocation" }).encode(
                                entry.invocation
                            );
                            if (
                                observed.requestIdentity !== entry.requestIdentity &&
                                observed.requestIdentity !== identity
                            )
                                return yield* fault(
                                    "Conflict",
                                    "Parent invocation identity differs from the local action."
                                );
                            yield* tx.put(outbox, entry.invocation.id, { ...entry, includedInBase: true });
                        }
                        for (const row of yield* acceptedIn(tx)) {
                            const observed = snapshot.pending.find(
                                (entry) => entry.invocation.id === row.key
                            );
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
                        for (const entry of snapshot.completed) {
                            const local = yield* tx.get(outbox, entry.invocation.id);
                            if (local?.includedInBase && (entry.receipt || entry.failure)) {
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
                            }
                        }
                        if (requestedActionIds)
                            for (const row of yield* acceptedIn(tx)) {
                                if (
                                    !requestedActionIds.includes(row.key as string) ||
                                    known.has(row.key as string)
                                )
                                    continue;
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
                        yield* rebase(tx);
                        return true;
                    })
                )
            );
            if (changed) yield* notify;
        }),
        syncParent: Effect.fn("Replica.syncParent", { root: true })(
            function* (source: OntologySource) {
                yield* open;
                yield* service.collectClientGarbage;
                yield* collectResults;
                // Validates source identity before any invocation can be submitted.
                yield* service.refreshParent(source);
                const session = yield* sessionFor(source);
                for (;;) {
                    const entry = yield* access(
                        tables.transaction((tx) =>
                            Effect.gen(function* () {
                                const head = (yield* pendingIn(tx))[0];
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
                                };
                                if (!head.submission) {
                                    const state = yield* position(tx);
                                    const sequence = (state.parentSubmissionSequence ?? 0) + 1;
                                    if (!Number.isSafeInteger(sequence))
                                        return yield* fault(
                                            "ValidationFailed",
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
                    yield* notify;
                    const result = yield* Effect.result(
                        Effect.gen(function* () {
                            const snapshot = yield* source.submit({
                                session: yield* sessionFor(source),
                                sequence: entry.submission!.sequence,
                                invocation: entry.invocation,
                                optimistic: entry.optimistic,
                                view: yield* requestedView(),
                            });
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
                                parent && (observed || local?.includedInBase)
                                    ? { sourceId: parent.sourceId }
                                    : undefined,
                        };
                    })
                )
            ),
        awaitAction: (id, settings) =>
            Effect.scoped(
                Effect.gen(function* () {
                    const changes = yield* service.subscribeChanges;
                    const pull = yield* Stream.toPull(changes);
                    for (;;) {
                        const status = yield* service.actionStatus(id);
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
                                kind: entry.failure ?? "ValidationFailed",
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
                Effect.tap(() => wake)
            ),
        wake,
        syncOnce,
        enqueue: Effect.fn("Replica.enqueue", { root: true })(function* (
            invocation: ActionRequest,
            settings?: { optimistic?: boolean }
        ) {
            yield* open;
            if (!invocation.id) return yield* fault("ValidationFailed", "An invocation ID is required.");
            if (invocation.attachmentUploads?.length)
                return yield* fault(
                    "NotImplemented",
                    "Persist attachment handles in the outbox; stage bytes through the blob service before dispatch."
                );
            const entry = yield* access(tables.transaction((tx) => enqueueIn(tx, invocation, settings)));
            yield* notify;
            yield* wake;
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
                                failureOutcome: undefined,
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
                Effect.tap(() => wake)
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
                Effect.tap(() => wake)
            ),
        invalidate: (objectTypes) =>
            access(
                tables.transaction((tx) =>
                    Effect.gen(function* () {
                        for (const row of yield* tx.loadSubset(coverage))
                            if (!objectTypes || objectTypes.includes(row.value.subset.objectType))
                                yield* tx.delete(coverage, row.key);
                        for (const demand of demands.values())
                            if (!objectTypes || objectTypes.includes(demand.subset.objectType))
                                demand.revision++;
                    })
                )
            ).pipe(Effect.andThen(wake)),
        demand: (subset) =>
            Effect.gen(function* () {
                const properties = new Set(
                    definitions.get(subset.objectType)?.properties.map((property) => property.name)
                );
                for (const index of indexesForQuery(subset.query ?? {}, properties))
                    yield* service.ensureIndex(subset.objectType, index);
                const key = subsetKey(subset);
                const copy = Table.make<BackendSubset>({ name: "subset-copy" }).decode(
                    Table.make<BackendSubset>({ name: "subset-copy" }).encode(subset)
                );
                yield* retain(subset.objectType, "remote", key, copy);
                yield* Effect.makeSpanScoped("Replica.demand", {
                    root: true,
                    attributes: { activity: "subscription", objectType: subset.objectType },
                });
                if (options.source)
                    return yield* options.source.demand({ ...copy, query: retentionQuery(copy.query) });
                const watched = adapter!.watchSubset?.(copy);
                const configuredInterval = adapter!.pollIntervalMs?.(copy);
                const demand = demands.get(key)!;
                demand.pollDisabled = !watched && configuredInterval === false;
                const pollIntervalMs =
                    watched || adapter!.changes || configuredInterval === false
                        ? undefined
                        : (configuredInterval ?? options.pollIntervalMs ?? 5_000);
                if (
                    pollIntervalMs !== undefined &&
                    (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 100)
                )
                    return yield* fault("ValidationFailed", "Subset poll interval must be at least 100 ms.");
                const hints =
                    watched ??
                    (pollIntervalMs === undefined
                        ? undefined
                        : Stream.fromEffectRepeat(Effect.sleep(pollIntervalMs)));
                if (!hints) return;
                demand.pollIntervalMs = pollIntervalMs;
                yield* Effect.forkScoped(
                    Effect.scoped(
                        Effect.gen(function* () {
                            yield* Effect.acquireRelease(
                                Effect.sync(() => {
                                    demand.watchers++;
                                }).pipe(Effect.andThen(diagnostics.changed)),
                                () =>
                                    Effect.sync(() => {
                                        demand.watchers--;
                                    }).pipe(Effect.andThen(diagnostics.changed))
                            );
                            const span = yield* Effect.currentSpan;
                            span.event("replica.subscribed", yield* Clock.currentTimeNanos);
                            yield* Stream.runForEach(hints, () =>
                                Effect.gen(function* () {
                                    span.event("replica.invalidation", yield* Clock.currentTimeNanos);
                                    demand.revision++;
                                    yield* diagnostics.changed;
                                    yield* wake;
                                })
                            );
                        })
                    ).pipe(
                        Effect.withSpan("Replica.watchSubset", {
                            root: true,
                            attributes: { activity: "subscription", objectType: copy.objectType },
                        }),
                        Effect.catch(() => wake)
                    ),
                    { startImmediately: true }
                );
            }),
        retainLocal: (objectType, query) => {
            const subset = { objectType, query };
            return retain(objectType, "reader", `reader:${subsetKey(subset)}`, subset);
        },
        retainActions: (ids) =>
            Effect.acquireRelease(
                Effect.gen(function* () {
                    yield* open;
                    if (ids)
                        yield* Schema.decodeUnknownEffect(Schema.Array(Schema.NonEmptyString))(ids).pipe(
                            Effect.mapError((cause) =>
                                fault("ValidationFailed", "Invalid action inspection IDs.", cause)
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
        collectGarbage: Effect.fn("Replica.collectGarbage")(function* (settings?: {
            limit?: number;
            olderThanMs?: number;
        }) {
            const limit = settings?.limit ?? 100;
            const age = settings?.olderThanMs ?? 24 * 60 * 60 * 1000;
            if (
                !Number.isSafeInteger(limit) ||
                limit < 1 ||
                limit > 10000 ||
                !Number.isFinite(age) ||
                age < 0
            )
                return yield* fault("ValidationFailed", "Invalid GC bounds.");
            const now = yield* Clock.currentTimeMillis;
            const removed = yield* access(
                tables.transaction((tx) =>
                    Effect.gen(function* () {
                        // Root leases are in the same database, so another tab's demand/read
                        // acquisition and this sweep serialize with each other. Unknown crashed
                        // owners remain conservative roots until an explicit owner-recovery pass.
                        const cursor = (yield* tx.get(sweep, "position"))?.after;
                        const candidates = yield* tx.loadSubset(retention, {
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
                            for (const root of yield* tx.loadSubset(roots, {
                                where: eq(field("objectType"), objectType),
                            })) {
                                if (!options.isOwnerAlive || (yield* options.isOwnerAlive(root.value.owner)))
                                    queries.push(root.value.query ?? {});
                                else yield* tx.delete(roots, root.key);
                            }
                            for (const root of yield* tx.loadSubset(actionQueries, {
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
                        for (const row of candidates) {
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
                            const actionProtected = (yield* tx.loadSubset(actionRows, {
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
                            yield* tx.delete(v.base, record.key);
                            if (v.inherited) yield* tx.delete(v.inherited, record.key);
                            const head = yield* tx.get(imported, "head");
                            if (head) yield* tx.put(imported, "head", { ...head, resident: false });
                            yield* tx.delete(retention, row.key);
                            for (const cached of yield* tx.loadSubset(coverage, {
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
        yield* connectReplicaParent(service, options.source);
    } else if (options.startSync !== false) {
        const poll = options.pollIntervalMs ?? 5000;
        if (!Number.isFinite(poll) || poll < 100)
            return yield* fault("ValidationFailed", "Sync poll interval must be at least 100 ms.");
        yield* Effect.forkScoped(
            Effect.forever(
                Effect.gen(function* () {
                    yield* syncOnce.pipe(Effect.catch(() => Effect.void));
                    const first = (yield* boundary(tables.read(pendingIn)))[0];
                    const now = yield* Clock.currentTimeMillis;
                    const delay =
                        first?.state === "queued" && first.nextAttemptAt !== undefined
                            ? Math.min(poll, Math.max(1, first.nextAttemptAt - now))
                            : poll;
                    yield* Effect.raceFirst(Queue.take(queue), Effect.sleep(delay));
                })
            )
        );
        if (options.connectivity)
            yield* Effect.forkScoped(Stream.runForEach(options.connectivity, () => wake));
        if (adapter?.changes?.watch)
            yield* Effect.forkScoped(
                Effect.gen(function* () {
                    const span = yield* Effect.currentSpan;
                    span.event("replica.subscribed", yield* Clock.currentTimeNanos);
                    yield* Stream.runForEach(adapter.changes!.watch!, () =>
                        Effect.gen(function* () {
                            span.event("replica.invalidation", yield* Clock.currentTimeNanos);
                            yield* wake;
                        })
                    );
                }).pipe(
                    Effect.withSpan("Replica.watchChanges", {
                        root: true,
                        attributes: { activity: "subscription" },
                    }),
                    Effect.catch(() => Effect.void)
                )
            );
    }
    if (options.startSync !== false && gc) {
        const collect = service.collectGarbage(gc).pipe(Effect.asVoid);
        const owned = gate.withPermits(1)(collect);
        yield* Effect.forkScoped(
            Effect.forever(
                Effect.sleep(gc.intervalMs).pipe(
                    Effect.andThen(owned),
                    Effect.catch((error) => Effect.logWarning("Replica GC pass failed", { kind: error.kind }))
                )
            )
        );
    }
    if (options.externalChanges)
        yield* Effect.forkScoped(
            Stream.runForEach(options.externalChanges, () => localNotify.pipe(Effect.andThen(wake)))
        );
    return service;
});
