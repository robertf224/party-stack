import { and, cursorOf, eq, field, lte } from "@party-stack/ontology-storage";
import { digestBytes } from "@party-stack/ontology-storage/blobs";
import { Table } from "@party-stack/ontology-storage/tables";
import { Clock, Effect, Option, Queue, Schema, Stream } from "effect";
import { ClientLeaseSchema } from "./clients.js";
import { BackendSubsetSchema, PendingActionSchema, protocolValueCodec } from "./protocol.js";
import { BackendError, classifyBackendFailure } from "./index.js";
import type { Row } from "@party-stack/ontology-storage";
import type { TablesService, Transaction } from "@party-stack/ontology-storage/tables";
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
    coverage: Schema.Array(Schema.Struct({ subset: BackendSubsetSchema, complete: Schema.Boolean })),
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
        const rows = yield* tx.loadSubset(table, {
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

interface Witness {
    stream: string;
    generation: number;
    ref: DeliveryRef;
    hash: string;
    record: DeliveryRecord;
}
interface Patch {
    stream: string;
    order: number;
    change: DeliveryChange;
}
interface DeliverySession {
    expiresAt: number;
    expected: number;
    acknowledged: number;
}
const liveAcknowledgments = new Map<string, Queue.Queue<void>>();
const sessionTable = (namespace: string) =>
    Table.make<DeliverySession>({ name: JSON.stringify([namespace, "delivery", "sessions"]) });
/** Acknowledgments work across request-scoped HTTP handlers. The live signal is
 * only a latency optimization; the producer also observes the stored watermark.
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
    const signal = liveAcknowledgments.get(position.streamId);
    if (signal) yield* Queue.offer(signal, undefined);
});
/** Reconstructible delivery state. Only transport handles and a dirty flag live on the heap.
 * capture runs in the same transaction as staging, so outgoing values cannot drift before send.
 */
export const makeDelivery = Effect.fn("Delivery.open")(function* (options: {
    tables: TablesService;
    namespace: string;
    changes: Effect.Effect<Stream.Stream<void, BackendError>, BackendError, Scope.Scope>;
    capture: (
        tx: Transaction,
        emit: (record: DeliveryRecord) => Effect.Effect<void, BackendError>
    ) => Effect.Effect<DeliveryMetadata, BackendError>;
    policy?: DeliveryPolicy;
}): Effect.fn.Return<DeliverySubscription, BackendError, Scope.Scope> {
    const limits = {
        maxRecords: 10_000,
        maxBytes: 16 * 1024 * 1024,
        frameBytes: 256 * 1024,
        frameRecords: 128,
        maxSubscriptions: 32,
        ackTimeoutMs: 30_000,
        heartbeatMs: 15_000,
        ...options.policy,
    };
    if (Object.values(limits).some((n) => !Number.isSafeInteger(n) || n < 1))
        return yield* failure("Delivery limits must be positive integers.", "InvalidConfiguration");
    const { tables } = options;
    const streamId = crypto.randomUUID();
    const names = (name: string) => JSON.stringify([options.namespace, "delivery", name]);
    const sessions = sessionTable(options.namespace);
    const records = Table.make<Witness>({ name: names("records") });
    const patches = Table.make<Patch>({ name: names("patches") });
    const clear = (
        tx: Transaction,
        table: Table<Witness> | Table<Patch>,
        stream: string,
        generation?: number
    ) =>
        scanDeliveryRows(
            tx,
            table as Table<Witness | Patch>,
            {
                where:
                    generation === undefined
                        ? eq(field("stream"), stream)
                        : and(eq(field("stream"), stream), eq(field("generation"), generation)),
            },
            (row) => tx.delete(table as Table<Witness | Patch>, row.key)
        );
    const release = (id: string) =>
        boundary(
            tables.transaction((tx) =>
                Effect.gen(function* () {
                    yield* clear(tx, records, id);
                    yield* clear(tx, patches, id);
                    yield* tx.delete(sessions, id);
                })
            )
        );
    yield* boundary(
        tables.transaction((tx) =>
            Effect.gen(function* () {
                yield* tx.ensureIndex(sessions, { name: "expiry", field: field("expiresAt") });
                yield* tx.ensureIndex(records, { name: "stream", field: field("stream") });
                yield* tx.ensureIndex(patches, { name: "stream", field: field("stream") });
                const now = yield* Clock.currentTimeMillis;
                for (const expired of yield* tx.loadSubset(sessions, {
                    where: lte(field("expiresAt"), now),
                    limit: limits.maxSubscriptions,
                })) {
                    yield* clear(tx, records, String(expired.key));
                    yield* clear(tx, patches, String(expired.key));
                    yield* tx.delete(sessions, expired.key);
                }
                if (
                    (yield* tx.loadSubset(sessions, { limit: limits.maxSubscriptions })).length >=
                    limits.maxSubscriptions
                )
                    return yield* failure("Delivery subscription capacity reached.", "RateLimited");
                yield* tx.put(sessions, streamId, {
                    expiresAt: now + limits.ackTimeoutMs + limits.heartbeatMs * 3,
                    expected: 0,
                    acknowledged: 0,
                });
            })
        )
    );
    yield* Effect.addFinalizer(() =>
        release(streamId).pipe(
            Effect.catch(() => Effect.void),
            Effect.tap(() => Effect.sync(() => liveAcknowledgments.delete(streamId)))
        )
    );
    const changes = yield* options.changes;
    const dirty = yield* Queue.sliding<void>(1);
    yield* Stream.runForEach(changes, () => Queue.offer(dirty, undefined)).pipe(Effect.forkScoped);
    let installed = 0;
    let signature: string | undefined;
    let consumed = false;
    const prepare = boundary(
        tables.transaction((tx) =>
            Effect.gen(function* () {
                const sequence = installed + 1;
                let count = 0;
                let bytes = 0;
                const emit = Effect.fnUntraced(function* (record: DeliveryRecord) {
                    const key = JSON.stringify([streamId, sequence, deliveryKey(deliveryRef(record))]);
                    const encoded = yield* Effect.try({
                        try: () => recordCodec.encode(record),
                        catch: () => failure("Selected data cannot be encoded.", "InvalidResponse"),
                    });
                    const encodedBytes = new TextEncoder().encode(encoded);
                    if (encodedBytes.length > limits.frameBytes / 2)
                        return yield* failure(
                            "A delivery record exceeds the configured frame budget.",
                            "RateLimited"
                        );
                    const prior = yield* tx.get(records, key);
                    if (!prior) count++;
                    bytes +=
                        encodedBytes.length -
                        (prior ? new TextEncoder().encode(recordCodec.encode(prior.record)).length : 0);
                    if (count > limits.maxRecords || bytes > limits.maxBytes)
                        return yield* failure(
                            "Selected delivery exceeds its configured size budget.",
                            "RateLimited"
                        );
                    const hash = yield* digestBytes({
                        type: "application/json",
                        stream: Stream.make(encodedBytes),
                    });
                    yield* tx.put(records, key, {
                        stream: streamId,
                        generation: sequence,
                        ref: deliveryRef(record),
                        hash,
                        record,
                    });
                });
                const metadata = yield* options.capture(tx, (record) => boundary(emit(record)));
                if (size(metadata) > limits.frameBytes / 2)
                    return yield* failure("Delivery metadata exceeds the frame budget.", "RateLimited");
                const { client: _client, ...identity } = metadata;
                const nextSignature = valueCodec.encode(identity);
                let order = 0;
                const append = (change: DeliveryChange) =>
                    tx.put(patches, JSON.stringify([streamId, order]), {
                        stream: streamId,
                        order: order++,
                        change,
                    });
                yield* scanDeliveryRows(
                    tx,
                    records,
                    { where: and(eq(field("stream"), streamId), eq(field("generation"), sequence)) },
                    (row) =>
                        Effect.gen(function* () {
                            const previous = installed
                                ? yield* tx.get(
                                      records,
                                      JSON.stringify([streamId, installed, deliveryKey(row.value.ref)])
                                  )
                                : undefined;
                            if (previous?.hash !== row.value.hash)
                                yield* append({ kind: "put", record: row.value.record });
                        })
                );
                if (installed)
                    yield* scanDeliveryRows(
                        tx,
                        records,
                        { where: and(eq(field("stream"), streamId), eq(field("generation"), installed)) },
                        (row) =>
                            Effect.gen(function* () {
                                if (
                                    !(yield* tx.get(
                                        records,
                                        JSON.stringify([streamId, sequence, deliveryKey(row.value.ref)])
                                    ))
                                )
                                    yield* append({ kind: "remove", ref: row.value.ref });
                            })
                    );
                const session = (yield* tx.get(sessions, streamId))!;
                yield* tx.put(sessions, streamId, {
                    ...session,
                    expiresAt:
                        (yield* Clock.currentTimeMillis) + limits.ackTimeoutMs + limits.heartbeatMs * 3,
                    expected: installed && order === 0 && signature === nextSignature ? installed : sequence,
                });
                if (installed && order === 0 && signature === nextSignature) {
                    yield* clear(tx, records, streamId, sequence);
                    return undefined;
                }
                return { sequence, metadata, nextSignature, count: order };
            })
        )
    );
    const loop = (): Stream.Stream<DeliveryFrame, BackendError> =>
        Stream.unwrap(
            Effect.gen(function* () {
                const next = yield* prepare;
                if (!next) {
                    yield* Effect.raceFirst(Queue.take(dirty), Effect.sleep(limits.heartbeatMs));
                    return Stream.suspend(loop);
                }
                const ack = yield* Queue.sliding<void>(1);
                liveAcknowledgments.set(streamId, ack);
                let part = 0;
                const frames = Stream.paginate(0, (start) =>
                    boundary(
                        tables.read((tx) =>
                            Effect.gen(function* () {
                                const changes: DeliveryChange[] = [];
                                let bytes = 256;
                                let order = start;
                                while (order < next.count && changes.length < limits.frameRecords) {
                                    const row = (yield* tx.get(patches, JSON.stringify([streamId, order])))!;
                                    const length = size(row.change);
                                    if (changes.length && bytes + length > limits.frameBytes) break;
                                    changes.push(row.change);
                                    bytes += length;
                                    order++;
                                }
                                const end = start === next.count;
                                const frame: DeliveryFrame = {
                                    streamId,
                                    sequence: next.sequence,
                                    previous: installed,
                                    part: part++,
                                    kind: installed ? "patch" : "snapshot",
                                    changes,
                                    end,
                                    ...(end ? { metadata: next.metadata } : {}),
                                };
                                return [[frame], end ? Option.none<number>() : Option.some(order)] as const;
                            })
                        )
                    )
                );
                const observeAck = Effect.gen(function* () {
                    for (;;) {
                        const session = yield* boundary(tables.get(sessions, streamId));
                        if (session && session.acknowledged >= next.sequence) return;
                        yield* Effect.raceFirst(Queue.take(ack), Effect.sleep(250));
                    }
                });
                const advance = observeAck.pipe(
                    Effect.timeoutOrElse({
                        duration: limits.ackTimeoutMs,
                        orElse: () => Effect.fail(failure("Delivery acknowledgment timed out.")),
                    }),
                    Effect.andThen(
                        boundary(
                            tables.transaction((tx) =>
                                Effect.gen(function* () {
                                    if (installed) yield* clear(tx, records, streamId, installed);
                                    yield* clear(tx, patches, streamId);
                                })
                            )
                        )
                    ),
                    Effect.tap(() =>
                        Effect.sync(() => {
                            installed = next.sequence;
                            signature = next.nextSignature;
                            liveAcknowledgments.delete(streamId);
                        })
                    ),
                    Effect.andThen(Effect.raceFirst(Queue.take(dirty), Effect.sleep(limits.heartbeatMs)))
                );
                return Stream.concat(
                    frames,
                    Stream.concat(Stream.fromEffect(advance).pipe(Stream.drain), Stream.suspend(loop))
                );
            })
        );
    return {
        frames: Stream.suspend(() => {
            if (consumed)
                return Stream.fail(failure("A delivery subscription has one consumer.", "Conflict"));
            consumed = true;
            return loop();
        }),
        acknowledge: (position) =>
            position.streamId === streamId
                ? acknowledgeDelivery(tables, options.namespace, position)
                : Effect.fail(failure("Invalid delivery acknowledgment.", "Conflict")),
    };
});

/** Frame staging and the installed position share the row transaction. No partial
 * snapshot or patch is observable, and retries cannot apply a batch twice.
 */
export const makeDeliveryReceiver = (options: {
    tables: TablesService;
    namespace: string;
    maxRecords?: number;
    maxBytes?: number;
    /** Durable outcome evidence can survive a later alias/application failure. */
    beforeApply?: (tx: Transaction, batch: IncomingDelivery) => Effect.Effect<void, BackendError>;
    apply: (tx: Transaction, batch: IncomingDelivery) => Effect.Effect<void, BackendError>;
}) =>
    Effect.sync(() => {
        const { tables } = options;
        const state = Table.make<{
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
        }>({ name: JSON.stringify([options.namespace, "incoming-delivery", "state"]) });
        const changes = Table.make<{ change: DeliveryChange }>({
            name: JSON.stringify([options.namespace, "incoming-delivery", "changes"]),
        });
        const frameHashes = Table.make<string>({
            name: JSON.stringify([options.namespace, "incoming-delivery", "frames"]),
        });
        const maxRecords = options.maxRecords ?? 20_000;
        const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
        const decode = Schema.decodeUnknownEffect(DeliveryFrameSchema);
        return {
            installed: boundary(tables.get(state, "installed")),
            receive: Effect.fn("Delivery.install")(function* (input: DeliveryFrame) {
                const frame = yield* decode(input).pipe(
                    Effect.mapError(() => failure("Invalid delivery frame.", "InvalidResponse"))
                );
                const ready = yield* boundary(
                    tables.transaction((tx) =>
                        Effect.gen(function* () {
                            const installed = yield* tx.get(state, "installed");
                            let pending = yield* tx.get(state, "pending");
                            if (
                                frame.previous !== frame.sequence - 1 ||
                                (frame.kind === "snapshot" && frame.sequence !== 1) ||
                                (!frame.end && frame.metadata)
                            )
                                return yield* failure(
                                    "Invalid delivery frame metadata or sequence.",
                                    "InvalidResponse"
                                );
                            const encoded = yield* Effect.try({
                                try: () => valueCodec.encode(frame),
                                catch: () => failure("Delivery data cannot be encoded.", "InvalidResponse"),
                            });
                            const bytes = new TextEncoder().encode(encoded);
                            const frameHash = yield* digestBytes({
                                type: "application/json",
                                stream: Stream.make(bytes),
                            });
                            if (
                                pending?.streamId === frame.streamId &&
                                pending.sequence === frame.sequence &&
                                frame.part < pending.nextPart
                            ) {
                                if ((yield* tx.get(frameHashes, frame.part)) !== frameHash)
                                    return yield* failure(
                                        "A delivery frame was reused with different contents.",
                                        "Conflict"
                                    );
                                return frame.end && pending.metadata ? pending : undefined;
                            }
                            if (frame.part === 0) {
                                const duplicate =
                                    installed?.streamId === frame.streamId &&
                                    installed.sequence === frame.sequence;
                                const starts =
                                    frame.kind === "snapshot" &&
                                    frame.sequence === 1 &&
                                    frame.previous === 0 &&
                                    installed?.streamId !== frame.streamId;
                                const follows =
                                    frame.kind === "patch" &&
                                    installed?.streamId === frame.streamId &&
                                    frame.sequence === installed.sequence + 1 &&
                                    frame.previous === installed.sequence;
                                if (!duplicate && !starts && !follows)
                                    return yield* failure(
                                        "Delivery position cannot resume; a snapshot is required.",
                                        "HistoryExpired"
                                    );
                                yield* tx.clear(changes);
                                yield* tx.clear(frameHashes);
                                pending = {
                                    streamId: frame.streamId,
                                    sequence: frame.sequence,
                                    previous: frame.previous,
                                    nextPart: 0,
                                    count: 0,
                                    bytes: 0,
                                    hash: "",
                                    kind: frame.kind,
                                    duplicate,
                                };
                            }
                            if (
                                !pending ||
                                pending.streamId !== frame.streamId ||
                                pending.sequence !== frame.sequence ||
                                pending.kind !== frame.kind ||
                                pending.previous !== frame.previous ||
                                frame.part !== pending.nextPart
                            )
                                return yield* failure("Delivery frames are out of order.", "HistoryExpired");
                            if (
                                pending.bytes + bytes.length > maxBytes ||
                                pending.count + frame.changes.length > maxRecords ||
                                frame.part > maxRecords + 1
                            )
                                return yield* failure(
                                    "Incoming delivery exceeds its configured budget.",
                                    "InvalidResponse"
                                );
                            for (const change of frame.changes)
                                yield* tx.put(changes, pending.count++, { change });
                            yield* tx.put(frameHashes, frame.part, frameHash);
                            pending = {
                                ...pending,
                                nextPart: pending.nextPart + 1,
                                bytes: pending.bytes + bytes.length,
                                hash: yield* digestBytes({
                                    type: "application/json",
                                    stream: Stream.make(new TextEncoder().encode(pending.hash + frameHash)),
                                }),
                            };
                            yield* tx.put(state, "pending", pending);
                            if (!frame.end) return undefined;
                            if (!frame.metadata)
                                return yield* failure(
                                    "A completed delivery needs metadata.",
                                    "InvalidResponse"
                                );
                            if (pending.duplicate && installed?.hash !== pending.hash)
                                return yield* failure(
                                    "A delivery sequence was reused with different contents.",
                                    "Conflict"
                                );
                            pending = { ...pending, metadata: frame.metadata };
                            yield* tx.put(state, "pending", pending);
                            return pending;
                        })
                    )
                );
                if (!ready?.metadata) return undefined;
                const batch = (tx: Transaction): IncomingDelivery => ({
                    kind: ready.kind,
                    position: frame,
                    metadata: ready.metadata!,
                    forEach: (visit) =>
                        boundary(scanDeliveryRows(tx, changes, {}, (row) => visit(row.value.change))),
                });
                if (options.beforeApply && !ready.duplicate)
                    yield* boundary(
                        tables.transaction((tx) =>
                            Effect.gen(function* () {
                                const pending = yield* tx.get(state, "pending");
                                if (
                                    pending?.streamId !== ready.streamId ||
                                    pending.sequence !== ready.sequence ||
                                    pending.hash !== ready.hash
                                )
                                    return yield* failure("Delivery staging was superseded.", "ViewReplaced");
                                yield* options.beforeApply!(tx, batch(tx));
                            })
                        )
                    );
                return yield* boundary(
                    tables.transaction((tx) =>
                        Effect.gen(function* () {
                            const pending = yield* tx.get(state, "pending");
                            if (
                                pending?.streamId !== ready.streamId ||
                                pending.sequence !== ready.sequence ||
                                pending.hash !== ready.hash
                            )
                                return yield* failure("Delivery staging was superseded.", "ViewReplaced");
                            if (!ready.duplicate) {
                                yield* options.apply(tx, batch(tx));
                                yield* tx.put(state, "installed", ready);
                            }
                            yield* tx.clear(changes);
                            yield* tx.clear(frameHashes);
                            yield* tx.delete(state, "pending");
                            return {
                                position: { streamId: frame.streamId, sequence: frame.sequence },
                                metadata: ready.metadata!,
                                duplicate: ready.duplicate,
                            };
                        })
                    )
                );
            }),
        };
    });
