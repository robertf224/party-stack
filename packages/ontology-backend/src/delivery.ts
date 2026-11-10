import { cursorOf, eq, field, lte } from "@party-stack/ontology-storage";
import { digestBytes } from "@party-stack/ontology-storage/blobs";
import { Table } from "@party-stack/ontology-storage/tables";
import { Clock, Deferred, Effect, Option, Queue, Schema, Semaphore, Stream } from "effect";
import { ClientLeaseSchema } from "./clients.js";
import { CompiledSubsetSchema, PendingActionSchema, protocolValueCodec } from "./protocol.js";
import { BackendError, classifyBackendFailure } from "./index.js";
import type { Row } from "@party-stack/ontology-storage";
import type { TablesService, Transaction, ReadTransaction } from "@party-stack/ontology-storage/tables";
import type { Scope } from "effect";

const KeySchema = Schema.Union([Schema.String, Schema.Finite]);
const Value = Schema.Record(Schema.String, Schema.Unknown);
export const DeliveryRefSchema = Schema.Union([
    Schema.Struct({ kind: Schema.Literals(["base", "override"]), objectType: Schema.String, key: KeySchema }),
    Schema.Struct({ kind: Schema.Literals(["pending", "completed"]), id: Schema.String }),
]);
export const DeliveryRecordSchema = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("base"), objectType: Schema.String, key: KeySchema, value: Value }),
    Schema.Struct({
        kind: Schema.Literal("override"),
        objectType: Schema.String,
        key: KeySchema,
        value: Schema.Union([
            Schema.Struct({ deleted: Schema.Literal(true) }),
            Schema.Struct({ deleted: Schema.Literal(false), value: Value }),
        ]),
    }),
    Schema.Struct({
        kind: Schema.Literals(["pending", "completed"]),
        id: Schema.String,
        value: PendingActionSchema,
    }),
]);
export type DeliveryRef = Schema.Schema.Type<typeof DeliveryRefSchema>;
export type DeliveryRecord = Schema.Schema.Type<typeof DeliveryRecordSchema>;
export const DeliveryChangeSchema = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("put"), record: DeliveryRecordSchema }),
    Schema.Struct({ kind: Schema.Literal("remove"), ref: DeliveryRefSchema }),
]);
export type DeliveryChange = Schema.Schema.Type<typeof DeliveryChangeSchema>;
export const DeliveryMetadataSchema = Schema.Struct({
    sourceId: Schema.NonEmptyString,
    schemaHash: Schema.NonEmptyString,
    generation: Schema.Int,
    revision: Schema.Int,
    cursor: Schema.optional(Schema.String),
    coverage: Schema.Array(
        Schema.Struct({
            subset: CompiledSubsetSchema,
            complete: Schema.Boolean,
            /** Previously confirmed resident coverage, independently of current freshness. */
            cached: Schema.optional(Schema.Boolean),
        })
    ),
    client: Schema.optional(ClientLeaseSchema),
});
export type DeliveryMetadata = Schema.Schema.Type<typeof DeliveryMetadataSchema>;
const Counter = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
export const DeliveryPositionSchema = Schema.Struct({ streamId: Schema.NonEmptyString, sequence: Counter });
export type DeliveryPosition = Schema.Schema.Type<typeof DeliveryPositionSchema>;
export const DeliveryFrameSchema = Schema.Struct({
    ...DeliveryPositionSchema.fields,
    sequence: Counter.check(Schema.isGreaterThan(0)),
    previous: Counter,
    part: Counter,
    kind: Schema.Literals(["snapshot", "patch"]),
    changes: Schema.Array(DeliveryChangeSchema),
    end: Schema.Boolean,
    metadata: Schema.optional(DeliveryMetadataSchema),
});
export type DeliveryFrame = Schema.Schema.Type<typeof DeliveryFrameSchema>;
export const DeliveryFrameCodec = protocolValueCodec(DeliveryFrameSchema);
export interface DeliverySubscription {
    readonly frames: Stream.Stream<DeliveryFrame, BackendError>;
    readonly acknowledge: (position: DeliveryPosition) => Effect.Effect<void, BackendError>;
}
export interface IncomingDelivery {
    readonly kind: "snapshot" | "patch";
    readonly position: DeliveryPosition;
    readonly metadata: DeliveryMetadata;
    readonly forEach: (
        visit: (change: DeliveryChange) => Effect.Effect<void, BackendError>
    ) => Effect.Effect<void, BackendError>;
}
export interface DeliveryPolicy {
    readonly maxRecords?: number;
    readonly maxBytes?: number;
    readonly frameBytes?: number;
    readonly frameRecords?: number;
    readonly maxSubscriptions?: number;
    readonly ackTimeoutMs?: number;
    readonly heartbeatMs?: number;
    /** Retain a disconnected logical subscription for resumption. Default 60 seconds. */
    readonly retentionMs?: number;
}
export const deliveryRef = (record: DeliveryRecord): DeliveryRef =>
    record.kind === "base" || record.kind === "override"
        ? { kind: record.kind, objectType: record.objectType, key: record.key }
        : { kind: record.kind, id: record.id };
export const deliveryKey = (ref: DeliveryRef): string =>
    "objectType" in ref
        ? JSON.stringify([ref.kind, ref.objectType, ref.key])
        : JSON.stringify([ref.kind, ref.id]);
const recordCodec = Table.make<DeliveryRecord>({ name: "delivery-record" });
const valueCodec = Table.make({ name: "delivery-value" });
const size = (value: unknown) => new TextEncoder().encode(valueCodec.encode(value)).length;
const failure = (message: string, kind: BackendError["kind"] = "Unavailable") =>
    new BackendError({
        operation: "delivery",
        kind,
        message,
        retryable: kind === "Unavailable" || kind === "RateLimited",
    });
const boundary = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    work.pipe(Effect.mapError((cause) => classifyBackendFailure("delivery.storage", cause)));

/** Storage cursors keep baseline/staging scans bounded, including after a crash. */
export const scanDeliveryRows = Effect.fnUntraced(function* <A>(
    tx: Transaction,
    table: Table<A>,
    query: import("@party-stack/ontology-storage").Query,
    visit: (
        row: Row<A>
    ) => Effect.Effect<void, BackendError | import("@party-stack/ontology-storage").OntologyStorageError>
) {
    let after = query.after;
    let remaining = query.limit;
    let offset = query.offset;
    for (;;) {
        const rows = yield* tx.query(table, {
            ...query,
            offset,
            after,
            limit: Math.min(128, remaining ?? 128),
        });
        if (!rows.length) return;
        for (const row of rows) yield* visit(row);
        if (remaining !== undefined) {
            remaining -= rows.length;
            if (remaining <= 0) return;
        }
        after = cursorOf(rows.at(-1)!, query);
        offset = undefined;
        if (rows.length < 128) return;
    }
});

/** Query pages preserve the original window while advancing by its complete sort cursor. */
export const scanSelectedRows = Effect.fnUntraced(function* <A>(
    load: (
        query: import("@party-stack/ontology-storage").Query
    ) => Effect.Effect<readonly Row<A>[], BackendError>,
    query: import("@party-stack/ontology-storage").Query = {},
    visit: (row: Row<A>) => Effect.Effect<void, BackendError>
) {
    let after = query.after;
    let remaining = query.limit;
    let offset = query.offset;
    for (;;) {
        const rows = yield* load({ ...query, offset, after, limit: Math.min(128, remaining ?? 128) });
        if (!rows.length) return;
        for (const row of rows) yield* visit(row);
        if (remaining !== undefined) {
            remaining -= rows.length;
            if (remaining <= 0) return;
        }
        after = cursorOf(rows.at(-1)!, query);
        offset = undefined;
        if (rows.length < 128) return;
    }
});

interface DeliverySession {
    format: 3;
    expiresAt: number;
    expected: number;
    acknowledged: number;
    binding: string;
    identity: string;
    rowSelection?: string;
    producer: string;
    installed: number;
    signature?: string;
    pending?: { sequence: number; metadata: DeliveryMetadata; nextSignature: string; count: number };
}
const sessionTable = (namespace: string) =>
    Table.make<DeliverySession>({ name: JSON.stringify([namespace, "delivery", "sessions"]) });
const deleteStreamRows = Effect.fnUntraced(function* <A extends { stream: string }>(
    tx: Transaction,
    table: Table<A>,
    stream: string
) {
    for (;;) {
        const rows = yield* tx.query(table, { where: eq(field("stream"), stream), limit: 128 });
        if (!rows.length) return;
        // Keys are disjoint. Submit a bounded batch together instead of waiting
        // for an IndexedDB round trip for every expired witness/patch.
        yield* Effect.forEach(rows, (row) => tx.delete(table, row.key), { concurrency: 128, discard: true });
    }
});
/** Bounded indexed expiry, shared by admission and host maintenance. */
export const collectDeliveryGarbage = Effect.fn("Delivery.collectGarbage")(function* (
    tables: TablesService,
    namespace: string,
    maxSessions = 4
) {
    return yield* boundary(
        tables.transaction((tx) =>
            Effect.gen(function* () {
                const sessions = sessionTable(namespace);
                yield* tx.ensureIndex(sessions, { name: "expiry", field: field("expiresAt") });
                const expired = yield* tx.query(sessions, {
                    where: lte(field("expiresAt"), yield* Clock.currentTimeMillis),
                    limit: maxSessions,
                });
                for (const row of expired) {
                    for (const part of ["records", "patches"]) {
                        const table = Table.make<{ stream: string }>({
                            name: JSON.stringify([namespace, "delivery", part]),
                        });
                        yield* tx.ensureIndex(table, { name: "stream", field: field("stream") });
                        yield* deleteStreamRows(tx, table, String(row.key));
                    }
                    yield* tx.delete(sessions, row.key);
                }
                return expired.length;
            })
        )
    );
});
/** Durable watermarks support ACK requests handled by another server instance.
 * The owning manager adds a local wakeup; producers also observe this stored position.
 */
export const acknowledgeDelivery = Effect.fn("Delivery.acknowledge")(function* (
    tables: TablesService,
    namespace: string,
    position: DeliveryPosition
) {
    yield* boundary(
        tables.transaction((tx) =>
            Effect.gen(function* () {
                const table = sessionTable(namespace);
                const session = yield* tx.get(table, position.streamId);
                if (!session || session.expiresAt < (yield* Clock.currentTimeMillis))
                    return yield* failure("Delivery expired.", "HistoryExpired");
                if (
                    !Number.isSafeInteger(position.sequence) ||
                    position.sequence < 0 ||
                    position.sequence > session.expected
                )
                    return yield* failure("Invalid delivery acknowledgment.", "Conflict");
                if (position.sequence > session.acknowledged)
                    yield* tx.put(table, position.streamId, { ...session, acknowledged: position.sequence });
            })
        )
    );
});
interface DeliveryMemory {
    readonly gate: Semaphore.Semaphore;
    readonly acknowledgments: Queue.Queue<void>;
    gone: Deferred.Deferred<never, BackendError>;
    producer: string;
    expiresAt: number;
    witnesses: Map<string, { readonly ref: DeliveryRef; readonly hash: string }>;
    pending?: {
        readonly sequence: number;
        readonly changes: readonly string[];
        readonly sizes: readonly number[];
    };
}
export interface DeliveryOpenOptions {
    /** Notify after every change affecting captured records or metadata. Events
     * may coalesce; reconnect captures current state to repair a subscription gap.
     * Heartbeats renew leases and fencing only, never poll the selected data. */
    readonly changes: Effect.Effect<Stream.Stream<void, BackendError>, BackendError, Scope.Scope>;
    readonly capture: (
        tx: Transaction,
        emit: (record: DeliveryRecord) => Effect.Effect<void, BackendError>
    ) => Effect.Effect<DeliveryMetadata, BackendError>;
    /** Renew an associated scoped client lease without capturing or advancing
     * delivered state. Runs with the producer fence in the same transaction. */
    readonly renew?: (tx: Transaction) => Effect.Effect<void, BackendError>;
    readonly policy?: DeliveryPolicy;
    readonly binding: string;
    readonly identity: string;
    /** Stable selected rows, excluding action interests and local generations. */
    readonly rowSelection?: string;
    readonly resume?: DeliveryPosition;
}
export interface DeliveryManager {
    readonly open: (
        options: DeliveryOpenOptions
    ) => Effect.Effect<DeliverySubscription, BackendError, Scope.Scope>;
    readonly acknowledge: (position: DeliveryPosition) => Effect.Effect<void, BackendError>;
    readonly collectGarbage: Effect.Effect<number, BackendError>;
}

/** One source owner retains bounded view buffers. Losing this scope requires a new
 * data snapshot; action acceptance, receipts and results remain in their own durable stores.
 * The small session header stays durable so an ACK handled by another process can
 * advance the live producer's watermark without sharing its temporary row buffers.
 */
export const makeDeliveryManager = Effect.fnUntraced(function* (options: {
    readonly tables: TablesService;
    readonly namespace: string;
}): Effect.fn.Return<DeliveryManager, never, Scope.Scope> {
    const { tables, namespace } = options;
    const sessions = sessionTable(namespace);
    const memories = new Map<string, DeliveryMemory>();
    const admission = Semaphore.makeUnsafe(1);
    let closed = false;
    const forget = Effect.fnUntraced(function* (
        stream: string,
        kind: "HistoryExpired" | "SessionReplaced" = "HistoryExpired"
    ) {
        const memory = memories.get(stream);
        if (!memory) return;
        memories.delete(stream);
        memory.pending = undefined;
        memory.witnesses.clear();
        yield* Deferred.fail(memory.gone, failure("Delivery view owner changed.", kind));
        yield* Queue.offer(memory.acknowledgments, undefined);
    });
    const prune = Effect.fnUntraced(function* () {
        const now = yield* Clock.currentTimeMillis;
        for (const [stream, memory] of memories) if (memory.expiresAt <= now) yield* forget(stream);
    });
    yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
            closed = true;
            for (const stream of memories.keys()) yield* forget(stream);
        })
    );
    const legacy = (part: string) =>
        Table.make<{ stream: string }>({ name: JSON.stringify([namespace, "delivery", part]) });
    const clearLegacy = Effect.fnUntraced(function* (tx: Transaction, stream: string) {
        for (const part of ["records", "patches"]) yield* deleteStreamRows(tx, legacy(part), stream);
    });
    const acknowledge = Effect.fn("Delivery.acknowledgeLocal")(function* (position: DeliveryPosition) {
        yield* acknowledgeDelivery(tables, namespace, position);
        const memory = memories.get(position.streamId);
        if (memory) yield* Queue.offer(memory.acknowledgments, undefined);
    });
    const open = Effect.fn("Delivery.open")(function* (
        options: DeliveryOpenOptions
    ): Effect.fn.Return<DeliverySubscription, BackendError, Scope.Scope> {
        const limits = {
            maxRecords: 10_000,
            maxBytes: 16 * 1024 * 1024,
            frameBytes: 256 * 1024,
            frameRecords: 128,
            maxSubscriptions: 32,
            ackTimeoutMs: 30_000,
            heartbeatMs: 15_000,
            ...options.policy,
            retentionMs: options.policy?.retentionMs ?? 60_000,
        };
        if (Object.values(limits).some((n) => !Number.isSafeInteger(n) || n < 1))
            return yield* failure("Delivery limits must be positive integers.", "InvalidConfiguration");
        const activeRetentionMs = Math.max(limits.retentionMs, limits.ackTimeoutMs + limits.heartbeatMs * 3);
        const producer = crypto.randomUUID();
        const acquire = admission.withPermits(1)(
            Effect.gen(function* () {
                if (closed) return yield* failure("Delivery owner closed.", "HistoryExpired");
                yield* prune();
                const gone = yield* Deferred.make<never, BackendError>();
                const priorMemory = options.resume && memories.get(options.resume.streamId);
                const configure = Effect.gen(function* () {
                    const outcome = yield* boundary(
                        tables.transaction((tx) =>
                            Effect.gen(function* () {
                                yield* tx.ensureIndex(sessions, {
                                    name: "expiry",
                                    field: field("expiresAt"),
                                });
                                const now = yield* Clock.currentTimeMillis;
                                for (const expired of yield* tx.query(sessions, {
                                    where: lte(field("expiresAt"), now),
                                    limit: limits.maxSubscriptions,
                                })) {
                                    yield* clearLegacy(tx, String(expired.key));
                                    yield* tx.delete(sessions, expired.key);
                                }
                                let streamId = options.resume?.streamId ?? crypto.randomUUID();
                                if (options.resume) {
                                    const prior = yield* tx.get(sessions, streamId);
                                    if (!prior || prior.expiresAt <= now || prior.binding !== options.binding)
                                        return yield* failure("Delivery history expired.", "HistoryExpired");
                                    if (
                                        prior.format !== 3 ||
                                        !priorMemory ||
                                        (prior.pending &&
                                            priorMemory.pending?.sequence !== prior.pending.sequence)
                                    ) {
                                        // A lost owner cannot reconstruct its target hashes. Retire
                                        // only this binding-matched session, then report expiry after
                                        // commit so a bounded fresh snapshot can take its slot.
                                        yield* clearLegacy(tx, streamId);
                                        yield* tx.delete(sessions, streamId);
                                        return { kind: "expired" as const, streamId };
                                    }
                                    if (prior.identity === options.identity) {
                                        const position = options.resume.sequence;
                                        if (position < prior.installed || position > prior.expected)
                                            return yield* failure(
                                                "Delivery position cannot resume.",
                                                "HistoryExpired"
                                            );
                                        const header = {
                                            ...prior,
                                            producer,
                                            acknowledged: Math.max(prior.acknowledged, position),
                                            expiresAt: now + activeRetentionMs,
                                        };
                                        yield* tx.put(sessions, streamId, header);
                                        return {
                                            kind: "resumed" as const,
                                            streamId,
                                            memory: priorMemory,
                                            header,
                                        };
                                    }
                                    if (
                                        prior.pending &&
                                        prior.rowSelection !== undefined &&
                                        prior.rowSelection === options.rowSelection &&
                                        options.resume.sequence === prior.installed
                                    ) {
                                        // Action interests may change while a data target is still
                                        // in flight. Replay its immutable bytes before capturing the
                                        // new interests; only an installed target may be promoted.
                                        const header = {
                                            ...prior,
                                            identity: options.identity,
                                            producer,
                                            expiresAt: now + activeRetentionMs,
                                        };
                                        yield* tx.put(sessions, streamId, header);
                                        return {
                                            kind: "resumed" as const,
                                            streamId,
                                            memory: priorMemory,
                                            header,
                                        };
                                    }
                                    if (
                                        options.resume.sequence > 0 &&
                                        options.resume.sequence === prior.expected &&
                                        (!prior.pending || prior.pending.sequence === options.resume.sequence)
                                    ) {
                                        // The client proves it installed the target, even with a
                                        // lost ACK. Diff the new membership against that target;
                                        // never relabel the previous pending batch's bytes.
                                        const header = {
                                            ...prior,
                                            identity: options.identity,
                                            rowSelection: options.rowSelection,
                                            producer,
                                            acknowledged: options.resume.sequence,
                                            installed: options.resume.sequence,
                                            signature: prior.pending?.nextSignature ?? prior.signature,
                                            pending: undefined,
                                            expiresAt: now + activeRetentionMs,
                                        };
                                        yield* tx.put(sessions, streamId, header);
                                        return {
                                            kind: "promoted" as const,
                                            streamId,
                                            memory: priorMemory,
                                            header,
                                        };
                                    }
                                    yield* clearLegacy(tx, streamId);
                                    yield* tx.delete(sessions, streamId);
                                    streamId = crypto.randomUUID();
                                }
                                if (
                                    (yield* tx.query(sessions, { limit: limits.maxSubscriptions })).length >=
                                    limits.maxSubscriptions
                                )
                                    return yield* failure(
                                        "Delivery subscription capacity reached.",
                                        "RateLimited"
                                    );
                                const header: DeliverySession = {
                                    format: 3,
                                    expiresAt: now + activeRetentionMs,
                                    expected: 0,
                                    acknowledged: 0,
                                    installed: 0,
                                    binding: options.binding,
                                    identity: options.identity,
                                    rowSelection: options.rowSelection,
                                    producer,
                                };
                                yield* tx.put(sessions, streamId, header);
                                return {
                                    kind: "fresh" as const,
                                    streamId,
                                    header,
                                    memory: {
                                        gate: Semaphore.makeUnsafe(1),
                                        acknowledgments: yield* Queue.sliding<void>(1),
                                        gone,
                                        producer,
                                        expiresAt: header.expiresAt,
                                        witnesses: new Map<string, { ref: DeliveryRef; hash: string }>(),
                                    } satisfies DeliveryMemory,
                                };
                            })
                        )
                    );
                    if (outcome.kind === "expired") {
                        yield* forget(outcome.streamId);
                        return yield* failure(
                            "Delivery view owner changed; acquire a new snapshot.",
                            "HistoryExpired"
                        );
                    }
                    if (closed) return yield* failure("Delivery owner closed.", "HistoryExpired");
                    if (options.resume && options.resume.streamId !== outcome.streamId)
                        yield* forget(options.resume.streamId, "SessionReplaced");
                    if (outcome.kind !== "fresh")
                        yield* Deferred.fail(
                            outcome.memory.gone,
                            failure("Delivery connection was superseded.", "SessionReplaced")
                        );
                    if (closed) return yield* failure("Delivery owner closed.", "HistoryExpired");
                    const memory: DeliveryMemory = outcome.memory;
                    memory.gone = gone;
                    memory.producer = producer;
                    memory.expiresAt = outcome.header.expiresAt;
                    if (outcome.kind === "promoted") memory.pending = undefined;
                    memories.set(outcome.streamId, memory);
                    return { streamId: outcome.streamId, memory, gone };
                });
                return yield* priorMemory ? priorMemory.gate.withPermits(1)(configure) : configure;
            })
        );
        const { streamId, memory, gone } = yield* Effect.acquireRelease(acquire, ({ streamId, memory }) =>
            memory.gate.withPermits(1)(
                boundary(
                    tables.transaction((tx) =>
                        Effect.gen(function* () {
                            const session = yield* tx.get(sessions, streamId);
                            if (session?.producer !== producer) return;
                            const expiresAt = (yield* Clock.currentTimeMillis) + limits.retentionMs;
                            yield* tx.put(sessions, streamId, { ...session, expiresAt });
                            return expiresAt;
                        })
                    )
                ).pipe(
                    Effect.tap((expiresAt) =>
                        Effect.sync(() => {
                            if (expiresAt !== undefined && memory.producer === producer)
                                memory.expiresAt = expiresAt;
                        })
                    ),
                    Effect.catch(() => Effect.void),
                    Effect.ensuring(
                        Effect.suspend(() =>
                            memories.get(streamId) !== memory
                                ? Queue.shutdown(memory.acknowledgments)
                                : Effect.void
                        )
                    )
                )
            )
        );
        const current = (tx: ReadTransaction) =>
            Effect.gen(function* () {
                if (closed || memories.get(streamId) !== memory)
                    return yield* failure("Delivery view owner changed.", "HistoryExpired");
                const session = yield* tx.get(sessions, streamId);
                if (!session || session.producer !== producer || memory.producer !== producer)
                    return yield* failure("Delivery connection was superseded.", "SessionReplaced");
                return session;
            });
        const changes = yield* options.changes;
        const dirty = yield* Queue.sliding<void>(1);
        yield* Effect.addFinalizer(() => Queue.shutdown(dirty));
        yield* Stream.runForEach(changes, () => Queue.offer(dirty, undefined)).pipe(Effect.forkScoped);
        let consumed = false;
        const renew = memory.gate
            .withPermits(1)(
                Effect.uninterruptibleMask((restore) =>
                    Effect.gen(function* () {
                        const expiresAt = yield* restore(
                            boundary(
                                tables.transaction((tx) =>
                                    Effect.gen(function* () {
                                        const session = yield* current(tx);
                                        if (options.renew) yield* options.renew(tx);
                                        const expiresAt =
                                            (yield* Clock.currentTimeMillis) + activeRetentionMs;
                                        yield* tx.put(sessions, streamId, { ...session, expiresAt });
                                        return expiresAt;
                                    })
                                )
                            )
                        );
                        if (closed || memories.get(streamId) !== memory || memory.producer !== producer)
                            return yield* failure("Delivery view owner changed.", "HistoryExpired");
                        memory.expiresAt = expiresAt;
                    })
                )
            )
            .pipe(Effect.withSpan("Delivery.renew", { attributes: { streamId } }));
        const waitForChange = Effect.gen(function* () {
            for (;;) {
                const changed = yield* Effect.raceFirst(
                    // Keep the hint queued if the heartbeat wins the race.
                    Queue.peek(dirty).pipe(Effect.as(true)),
                    Effect.sleep(limits.heartbeatMs).pipe(Effect.as(false))
                );
                if (changed) {
                    yield* Queue.take(dirty);
                    return;
                }
                yield* renew;
            }
        });
        const prepare = memory.gate
            .withPermits(1)(
                Effect.uninterruptibleMask((restore) =>
                    Effect.gen(function* () {
                        let prepared:
                            | {
                                  witnesses: DeliveryMemory["witnesses"];
                                  pending: DeliveryMemory["pending"];
                                  expiresAt: number;
                              }
                            | undefined;
                        const result = yield* restore(
                            boundary(
                                tables.transaction((tx) =>
                                    Effect.gen(function* () {
                                        const session = yield* current(tx);
                                        const installed = session.installed;
                                        const signature = session.signature;
                                        yield* Effect.annotateCurrentSpan({
                                            streamId,
                                            installed,
                                            acknowledged: session.acknowledged,
                                            expected: session.expected,
                                            replay: Boolean(session.pending),
                                        });
                                        if (session.pending) {
                                            if (memory.pending?.sequence !== session.pending.sequence)
                                                return yield* failure(
                                                    "Delivery view buffer expired.",
                                                    "HistoryExpired"
                                                );
                                            // Replay precedes a fresh capture: changes while this
                                            // subscriber was disconnected had no live notification.
                                            yield* Queue.offer(dirty, undefined);
                                            return session.pending;
                                        }
                                        const sequence = installed + 1;
                                        const witnesses = new Map(memory.witnesses);
                                        const patches = new Map<string, DeliveryChange>();
                                        const seen = new Map<string, number>();
                                        let count = 0;
                                        let bytes = 0;
                                        const buffered = new Map<
                                            string,
                                            { record: DeliveryRecord; encoded: Uint8Array }
                                        >();
                                        const flush = Effect.gen(function* () {
                                            const page = [...buffered];
                                            buffered.clear();
                                            const hashed = yield* Effect.forEach(
                                                page,
                                                ([ref, value]) =>
                                                    Effect.map(
                                                        digestBytes({
                                                            type: "application/json",
                                                            stream: Stream.make(value.encoded),
                                                        }),
                                                        (hash) => ({ ref, record: value.record, hash })
                                                    ),
                                                { concurrency: 128 }
                                            );
                                            for (const { ref, record, hash } of hashed) {
                                                if (witnesses.get(ref)?.hash === hash) continue;
                                                witnesses.set(ref, { ref: deliveryRef(record), hash });
                                                patches.set(ref, { kind: "put", record });
                                            }
                                        });
                                        const emit = Effect.fnUntraced(function* (record: DeliveryRecord) {
                                            const ref = deliveryKey(deliveryRef(record));
                                            const encoded = yield* Effect.try({
                                                try: () => recordCodec.encode(record),
                                                catch: () =>
                                                    failure(
                                                        "Selected data cannot be encoded.",
                                                        "InvalidResponse"
                                                    ),
                                            });
                                            const encodedBytes = new TextEncoder().encode(encoded);
                                            if (encodedBytes.length > limits.frameBytes / 2)
                                                return yield* failure(
                                                    "A delivery record exceeds the configured frame budget.",
                                                    "RateLimited"
                                                );
                                            const previousSize = seen.get(ref);
                                            if (previousSize === undefined) count++;
                                            bytes += encodedBytes.length - (previousSize ?? 0);
                                            seen.set(ref, encodedBytes.length);
                                            if (count > limits.maxRecords || bytes > limits.maxBytes)
                                                return yield* failure(
                                                    "Selected delivery exceeds its configured size budget.",
                                                    "RateLimited"
                                                );
                                            // Persistence used to clone each record. Retained buffers must
                                            // likewise be independent of mutable objects owned by capture.
                                            const canonical = yield* Effect.try({
                                                try: () => recordCodec.decode(encoded),
                                                catch: () =>
                                                    failure(
                                                        "Selected data cannot be decoded.",
                                                        "InvalidResponse"
                                                    ),
                                            });
                                            buffered.set(ref, { record: canonical, encoded: encodedBytes });
                                            if (buffered.size === 128) yield* flush;
                                        });
                                        const captured = yield* options
                                            .capture(tx, (record) => boundary(emit(record)))
                                            .pipe(Effect.withSpan("Delivery.capture"));
                                        yield* flush;
                                        const encodedMetadata = valueCodec.encode(captured);
                                        if (
                                            new TextEncoder().encode(encodedMetadata).length >
                                            limits.frameBytes / 2
                                        )
                                            return yield* failure(
                                                "Delivery metadata exceeds the frame budget.",
                                                "RateLimited"
                                            );
                                        const metadata = valueCodec.decode(
                                            encodedMetadata
                                        ) as DeliveryMetadata;
                                        const { client: _client, ...identity } = metadata;
                                        const nextSignature = valueCodec.encode(identity);
                                        for (const [ref, witness] of witnesses) {
                                            if (seen.has(ref)) continue;
                                            patches.set(ref, { kind: "remove", ref: witness.ref });
                                            witnesses.delete(ref);
                                        }
                                        const order = patches.size;
                                        const pending =
                                            installed && order === 0 && signature === nextSignature
                                                ? undefined
                                                : { sequence, metadata, nextSignature, count: order };
                                        yield* Effect.annotateCurrentSpan({
                                            sequence,
                                            changes: order,
                                            records: count,
                                            generation: metadata.generation,
                                            revision: metadata.revision,
                                        });
                                        const expiresAt =
                                            (yield* Clock.currentTimeMillis) + activeRetentionMs;
                                        yield* tx.put(sessions, streamId, {
                                            ...session,
                                            expiresAt,
                                            pending,
                                            expected: pending ? sequence : installed,
                                        });
                                        const payload = [...patches.values()].map((change) =>
                                            valueCodec.encode(change)
                                        );
                                        prepared = {
                                            witnesses,
                                            expiresAt,
                                            pending: pending
                                                ? {
                                                      sequence,
                                                      changes: payload,
                                                      sizes: payload.map(
                                                          (encoded) =>
                                                              new TextEncoder().encode(encoded).length
                                                      ),
                                                  }
                                                : undefined,
                                        };
                                        return pending;
                                    })
                                )
                            )
                        );
                        // Publish only after capture and the small header commit. Failed or
                        // interrupted capture cannot replace the last installed target.
                        if (prepared) {
                            if (closed || memories.get(streamId) !== memory || memory.producer !== producer)
                                return yield* failure("Delivery view owner changed.", "HistoryExpired");
                            memory.witnesses = prepared.witnesses;
                            memory.pending = prepared.pending;
                            memory.expiresAt = prepared.expiresAt;
                        }
                        return result;
                    })
                )
            )
            .pipe(Effect.withSpan("Delivery.prepare"));
        const loop = (): Stream.Stream<DeliveryFrame, BackendError> =>
            Stream.unwrap(
                Effect.gen(function* () {
                    const next = yield* prepare;
                    if (!next) {
                        yield* waitForChange;
                        return Stream.suspend(loop);
                    }
                    let part = 0;
                    const frames = Stream.paginate(0, (start) =>
                        boundary(
                            tables.read((tx) =>
                                Effect.gen(function* () {
                                    // The durable producer fence is checked per frame, including
                                    // when a different server owner superseded this stream.
                                    const head = yield* current(tx);
                                    const payload = memory.pending;
                                    if (!payload || payload.sequence !== next.sequence)
                                        return yield* failure(
                                            "Delivery view buffer expired.",
                                            "HistoryExpired"
                                        );
                                    const changes: DeliveryChange[] = [];
                                    let bytes = 256;
                                    let order = start;
                                    while (order < next.count && changes.length < limits.frameRecords) {
                                        const length = payload.sizes[order]!;
                                        if (changes.length && bytes + length > limits.frameBytes) break;
                                        changes.push(
                                            yield* Effect.try({
                                                try: () =>
                                                    valueCodec.decode(
                                                        payload.changes[order]!
                                                    ) as DeliveryChange,
                                                catch: () =>
                                                    failure(
                                                        "Delivery buffer cannot be decoded.",
                                                        "InvalidResponse"
                                                    ),
                                            })
                                        );
                                        bytes += length;
                                        order++;
                                    }
                                    const end = order === next.count;
                                    const frame: DeliveryFrame = {
                                        streamId,
                                        sequence: next.sequence,
                                        previous: head.installed,
                                        part: part++,
                                        kind: head.installed ? "patch" : "snapshot",
                                        changes,
                                        end,
                                        ...(end ? { metadata: next.metadata } : {}),
                                    };
                                    return [
                                        [frame],
                                        end ? Option.none<number>() : Option.some(order),
                                    ] as const;
                                })
                            )
                        )
                    );
                    const observeAck = Effect.gen(function* () {
                        for (;;) {
                            const session = yield* boundary(tables.read((tx) => current(tx)));
                            if (session.acknowledged >= next.sequence) return;
                            yield* Effect.raceFirst(Queue.take(memory.acknowledgments), Effect.sleep(250));
                        }
                    }).pipe(
                        Effect.withSpan("Delivery.awaitAcknowledgment", {
                            attributes: { streamId, sequence: next.sequence },
                        })
                    );
                    const advance = observeAck.pipe(
                        Effect.timeoutOrElse({
                            duration: limits.ackTimeoutMs,
                            orElse: () => Effect.fail(failure("Delivery acknowledgment timed out.")),
                        }),
                        Effect.andThen(
                            memory.gate.withPermits(1)(
                                Effect.uninterruptibleMask((restore) =>
                                    Effect.gen(function* () {
                                        const expiresAt = yield* restore(
                                            boundary(
                                                tables.transaction((tx) =>
                                                    Effect.gen(function* () {
                                                        const head = yield* current(tx);
                                                        const expiresAt =
                                                            (yield* Clock.currentTimeMillis) +
                                                            activeRetentionMs;
                                                        yield* tx.put(sessions, streamId, {
                                                            ...head,
                                                            installed: next.sequence,
                                                            signature: next.nextSignature,
                                                            pending: undefined,
                                                            expiresAt,
                                                        });
                                                        return expiresAt;
                                                    })
                                                )
                                            )
                                        );
                                        memory.pending = undefined;
                                        memory.expiresAt = expiresAt;
                                    })
                                )
                            )
                        ),
                        Effect.andThen(waitForChange)
                    );
                    return Stream.concat(
                        Stream.concat(frames, Stream.fromEffect(advance).pipe(Stream.drain)),
                        Stream.suspend(loop)
                    );
                })
            );
        return {
            frames: Stream.suspend(() => {
                if (consumed)
                    return Stream.fail(failure("A delivery subscription has one consumer.", "Conflict"));
                consumed = true;
                return loop();
            }).pipe(Stream.interruptWhen(Deferred.await(gone))),
            acknowledge: (position) =>
                position.streamId === streamId
                    ? acknowledge(position)
                    : Effect.fail(failure("Invalid delivery acknowledgment.", "Conflict")),
        };
    });
    return {
        open,
        acknowledge,
        collectGarbage: admission.withPermits(1)(
            prune().pipe(Effect.andThen(collectDeliveryGarbage(tables, namespace)))
        ),
    };
});

const bufferedFrameHash = (encoded: string) =>
    boundary(
        digestBytes({ type: "application/json", stream: Stream.make(new TextEncoder().encode(encoded)) })
    );
const decodeDeliveryFrame = Schema.decodeUnknownEffect(DeliveryFrameSchema);

interface InstalledDelivery {
    streamId: string;
    sequence: number;
    previous: number;
    nextPart: number;
    count: number;
    bytes: number;
    hash: string;
    kind: "snapshot" | "patch";
    duplicate: boolean;
    metadata?: DeliveryMetadata;
}
interface BufferedDelivery extends InstalledDelivery {
    readonly frames: readonly { readonly encoded: string; readonly hash: string }[];
}

/** A scoped receiver retains bounded immutable frame bytes until atomic installation.
 * Installed positions and receipt evidence stay durable; losing partial frame bytes
 * requires replay from the installed position, or a fresh snapshot.
 */
export const makeDeliveryReceiver = Effect.fnUntraced(function* (options: {
    tables: TablesService;
    namespace: string;
    maxRecords?: number;
    maxBytes?: number;
    /** Durable outcome evidence can survive a later alias/application failure. */
    beforeApply?: (tx: Transaction, batch: IncomingDelivery) => Effect.Effect<void, BackendError>;
    apply: (tx: Transaction, batch: IncomingDelivery) => Effect.Effect<void, BackendError>;
}) {
    const { tables } = options;
    const state = Table.make<InstalledDelivery>({
        name: JSON.stringify([options.namespace, "incoming-delivery", "state"]),
    });
    const owners = Table.make<number>({
        name: JSON.stringify([options.namespace, "incoming-delivery", "owner"]),
    });
    const maxRecords = options.maxRecords ?? 20_000;
    const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    const gate = Semaphore.makeUnsafe(1);
    let pending: BufferedDelivery | undefined;
    let closed = false;
    const owner = yield* boundary(
        tables.transaction((tx) =>
            Effect.gen(function* () {
                const stored = yield* tx.get(owners, "active", { forUpdate: true });
                const previous = stored ?? 0;
                if (!Number.isSafeInteger(previous) || previous >= Number.MAX_SAFE_INTEGER)
                    return yield* failure("Delivery receiver incarnation exhausted.", "InvalidConfiguration");
                if (stored === undefined) {
                    // Upgrade cleanup only: no receiver in this implementation stages row records.
                    yield* tx.clear(
                        Table.make({
                            name: JSON.stringify([options.namespace, "incoming-delivery", "changes"]),
                        })
                    );
                    yield* tx.clear(
                        Table.make({
                            name: JSON.stringify([options.namespace, "incoming-delivery", "frames"]),
                        })
                    );
                    yield* tx.delete(state, "pending");
                }
                yield* tx.put(owners, "active", previous + 1);
                return previous + 1;
            })
        )
    );
    const assertOwner = Effect.fnUntraced(function* (tx: ReadTransaction, write = false) {
        if (
            closed ||
            (yield* write
                ? (tx as Transaction).get(owners, "active", { forUpdate: true })
                : tx.get(owners, "active")) !== owner
        )
            return yield* failure("Delivery receiver owner changed.", "ViewReplaced");
    });
    yield* Effect.addFinalizer(() =>
        gate.withPermit(
            Effect.sync(() => {
                closed = true;
                pending = undefined;
            })
        )
    );
    const installed = boundary(
        tables.read((tx) =>
            Effect.gen(function* () {
                yield* assertOwner(tx);
                return yield* tx.get(state, "installed");
            })
        )
    );
    const decodeFrame = (encoded: string) =>
        Effect.try({
            try: () => valueCodec.decode(encoded) as DeliveryFrame,
            catch: () => failure("Buffered delivery data cannot be decoded.", "InvalidResponse"),
        });
    const batch = Effect.fnUntraced(function* (ready: BufferedDelivery) {
        // Give each callback fresh metadata, and each traversal fresh mutable records.
        // Metadata-only consumers must not reconstruct every record in the final
        // frame. The private snapshot never follows a callback's mutable copy.
        const metadata = yield* Effect.try({
            try: () => valueCodec.decode(valueCodec.encode(ready.metadata)) as DeliveryMetadata,
            catch: () => failure("Buffered delivery metadata cannot be decoded.", "InvalidResponse"),
        }).pipe(Effect.withSpan("Delivery.install.copyMetadata"));
        const result: IncomingDelivery = {
            kind: ready.kind,
            position: { streamId: ready.streamId, sequence: ready.sequence },
            metadata,
            forEach: Effect.fnUntraced(function* (visit) {
                for (const retained of ready.frames) {
                    const frame = yield* decodeFrame(retained.encoded);
                    for (const change of frame.changes) yield* visit(change);
                }
            }),
        };
        return result;
    });
    return {
        installed,
        resume: Effect.map(installed, (current) =>
            pending && pending.streamId !== current?.streamId
                ? { streamId: pending.streamId, sequence: 0 }
                : current
                  ? { streamId: current.streamId, sequence: current.sequence }
                  : undefined
        ),
        forget: gate.withPermit(
            Effect.uninterruptibleMask((restore) =>
                restore(
                    boundary(
                        tables.transaction((tx) =>
                            Effect.gen(function* () {
                                yield* assertOwner(tx, true);
                                yield* tx.clear(state);
                            })
                        )
                    )
                ).pipe(
                    Effect.tap(() =>
                        Effect.sync(() => {
                            pending = undefined;
                        })
                    )
                )
            )
        ),
        receive: Effect.fn("Delivery.install")(
            function* (input: DeliveryFrame) {
                const current = yield* installed.pipe(Effect.withSpan("Delivery.install.readPosition"));
                const frame = yield* decodeDeliveryFrame(input).pipe(
                    Effect.mapError(() => failure("Invalid delivery frame.", "InvalidResponse")),
                    Effect.withSpan("Delivery.install.validateFrame")
                );
                yield* Effect.annotateCurrentSpan({
                    streamId: frame.streamId,
                    sequence: frame.sequence,
                    part: frame.part,
                    end: frame.end,
                    changes: frame.changes.length,
                });
                if (
                    frame.previous !== frame.sequence - 1 ||
                    (frame.kind === "snapshot" && frame.sequence !== 1) ||
                    (!frame.end && frame.metadata)
                )
                    return yield* failure("Invalid delivery frame metadata or sequence.", "InvalidResponse");
                const buffered = yield* Effect.try({
                    try: () => {
                        // Capture metadata and encode the retained frame in one
                        // synchronous section, before hashing can yield to callers.
                        const metadata = frame.metadata
                            ? (valueCodec.decode(valueCodec.encode(frame.metadata)) as DeliveryMetadata)
                            : undefined;
                        return {
                            metadata,
                            encoded: valueCodec.encode({ ...frame, ...(metadata ? { metadata } : {}) }),
                        };
                    },
                    catch: () => failure("Delivery data cannot be encoded.", "InvalidResponse"),
                }).pipe(Effect.withSpan("Delivery.install.serializeFrame"));
                const { encoded } = buffered;
                const bytes = new TextEncoder().encode(encoded).length;
                const frameHash = yield* bufferedFrameHash(encoded).pipe(
                    Effect.withSpan("Delivery.install.hashFrame")
                );
                let ready: BufferedDelivery | undefined;
                if (
                    pending?.streamId === frame.streamId &&
                    pending.sequence === frame.sequence &&
                    frame.part < pending.nextPart
                ) {
                    if (pending.frames[frame.part]?.hash !== frameHash)
                        return yield* failure(
                            "A delivery frame was reused with different contents.",
                            "Conflict"
                        );
                    ready = frame.end && pending.metadata ? pending : undefined;
                } else {
                    let prior = pending;
                    if (frame.part === 0) {
                        const duplicate =
                            current?.streamId === frame.streamId && current.sequence === frame.sequence;
                        const starts =
                            frame.kind === "snapshot" &&
                            frame.sequence === 1 &&
                            frame.previous === 0 &&
                            current?.streamId !== frame.streamId;
                        const follows =
                            frame.kind === "patch" &&
                            current?.streamId === frame.streamId &&
                            frame.sequence === current.sequence + 1 &&
                            frame.previous === current.sequence;
                        if (!duplicate && !starts && !follows)
                            return yield* failure(
                                "Delivery position cannot resume; a snapshot is required.",
                                "HistoryExpired"
                            );
                        prior = {
                            streamId: frame.streamId,
                            sequence: frame.sequence,
                            previous: frame.previous,
                            nextPart: 0,
                            count: 0,
                            bytes: 0,
                            hash: "",
                            kind: frame.kind,
                            duplicate,
                            frames: [],
                        };
                    }
                    if (
                        !prior ||
                        prior.streamId !== frame.streamId ||
                        prior.sequence !== frame.sequence ||
                        prior.kind !== frame.kind ||
                        prior.previous !== frame.previous ||
                        frame.part !== prior.nextPart
                    )
                        return yield* failure("Delivery frames are out of order.", "HistoryExpired");
                    if (
                        prior.bytes + bytes > maxBytes ||
                        prior.count + frame.changes.length > maxRecords ||
                        frame.part > maxRecords + 1
                    )
                        return yield* failure(
                            "Incoming delivery exceeds its configured budget.",
                            "InvalidResponse"
                        );
                    const next: BufferedDelivery = {
                        ...prior,
                        count: prior.count + frame.changes.length,
                        nextPart: prior.nextPart + 1,
                        bytes: prior.bytes + bytes,
                        hash: yield* bufferedFrameHash(prior.hash + frameHash).pipe(
                            Effect.withSpan("Delivery.install.hashChain")
                        ),
                        frames: [...prior.frames, { encoded, hash: frameHash }],
                    };
                    if (frame.end) {
                        if (!buffered.metadata)
                            return yield* failure("A completed delivery needs metadata.", "InvalidResponse");
                        if (next.duplicate && current?.hash !== next.hash)
                            return yield* failure(
                                "A delivery sequence was reused with different contents.",
                                "Conflict"
                            );
                        next.metadata = buffered.metadata;
                        ready = next;
                    }
                    pending = next;
                }
                if (!ready?.metadata) return undefined;
                // Defensive recovery if interruption followed the durable install but preceded local cleanup.
                if (
                    current?.streamId === ready.streamId &&
                    current.sequence === ready.sequence &&
                    current.hash === ready.hash
                )
                    ready = { ...ready, duplicate: true };
                const completed = ready;
                if (options.beforeApply && !completed.duplicate)
                    yield* boundary(
                        tables.transaction((tx) =>
                            Effect.gen(function* () {
                                yield* assertOwner(tx, true);
                                yield* options.beforeApply!(tx, yield* batch(completed));
                            })
                        )
                    ).pipe(Effect.withSpan("Delivery.install.checkpointTransaction"));
                return yield* Effect.uninterruptibleMask((restore) =>
                    restore(
                        boundary(
                            tables.transaction((tx) =>
                                Effect.gen(function* () {
                                    yield* assertOwner(tx, true);
                                    if (!completed.duplicate) {
                                        yield* options.apply(tx, yield* batch(completed));
                                        // Persist a fresh decode, never a callback's mutable metadata.
                                        const canonical = yield* batch(completed);
                                        const { frames: _, ...position } = completed;
                                        yield* tx
                                            .put(state, "installed", {
                                                ...position,
                                                metadata: canonical.metadata,
                                            })
                                            .pipe(Effect.withSpan("Delivery.install.savePosition"));
                                    }
                                    return {
                                        position: {
                                            streamId: completed.streamId,
                                            sequence: completed.sequence,
                                        },
                                        metadata: (yield* batch(completed)).metadata,
                                        duplicate: completed.duplicate,
                                    };
                                })
                            )
                        ).pipe(Effect.withSpan("Delivery.install.transaction"))
                    ).pipe(
                        Effect.tap(() =>
                            Effect.sync(() => {
                                pending = undefined;
                            })
                        )
                    )
                );
            },
            // The outer fn span includes admission wait. useSpan observes the
            // active body without changing its parent or frame annotations.
            (work) => gate.withPermit(Effect.useSpan("Delivery.install.active", () => work))
        ),
    };
});
