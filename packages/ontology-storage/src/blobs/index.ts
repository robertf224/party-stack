import { Clock, Context, Effect, Exit, Layer, Schema } from "effect";
import { Table, eq, ne, field, lte, and, type Cursor } from "../model.js";
import { cursorOf } from "../query/evaluate.js";
import { Tables, type TablesService, type ReadTransaction, type Transaction } from "../tables.js";
import {
    BlobBytes,
    BlobRecordSchema,
    BlobMetadataSchema,
    blobFailure,
    type BlobBytesService,
    type BlobMetadata,
    type BlobRecord,
    type BlobStorageError,
} from "./model.js";
import type { OntologyStorageError } from "../errors.js";

export * from "./model.js";
export { collectAttachments, collectActionAttachments } from "./attachments.js";
export type { AttachmentReference } from "./attachments.js";
type Failure = BlobStorageError | OntologyStorageError;
export interface BlobRetentionTransaction {
    /** Replace this owner's durable roots in the same transaction as its outbox entry. */
    readonly retain: (owner: string, ids: readonly string[]) => Effect.Effect<void, Failure>;
    readonly release: (owner: string) => Effect.Effect<void, Failure>;
}
export interface BlobStorageService {
    readonly in: (tx: Transaction) => BlobRetentionTransaction;
    readonly metadata: (id: string) => Effect.Effect<BlobRecord | undefined, Failure>;
    readonly records: (
        query?: import("../model.js").Query
    ) => Effect.Effect<import("../model.js").Row<BlobRecord>[], Failure>;
    readonly stage: (id: string, value: Blob) => Effect.Effect<void, Failure>;
    readonly cache: (id: string, value: Blob) => Effect.Effect<void, Failure>;
    /** Local read. The caller decides whether a miss should acquire remote bytes. */
    readonly read: (id: string) => Effect.Effect<Blob | undefined, Failure>;
    readonly updateMetadata: (id: string, value: BlobMetadata) => Effect.Effect<BlobRecord, Failure>;
    readonly bindRemoteId: (id: string, remoteId: string) => Effect.Effect<void, Failure>;
    readonly collectGarbage: (options: {
        readonly olderThanMs: number;
        readonly limit?: number;
    }) => Effect.Effect<number, Failure>;
    /** Retry detached generations and abandoned writes; unknown live owners are left alone. */
    readonly recover: Effect.Effect<void, Failure>;
}
export class BlobStorage extends Context.Service<BlobStorage, BlobStorageService>()(
    "@party-stack/ontology-storage/blobs/BlobStorage"
) {
    static readonly layer = (namespace: string) =>
        Layer.effect(
            BlobStorage,
            Effect.gen(function* () {
                return yield* makeBlobStorage({ namespace, tables: yield* Tables, bytes: yield* BlobBytes });
            })
        );
}
export interface BlobStorageOptions {
    readonly namespace: string;
    readonly tables: TablesService;
    readonly bytes: BlobBytesService;
    readonly registerOwner?: (owner: string) => Effect.Effect<void, Failure, import("effect").Scope.Scope>;
    readonly isOwnerAlive?: (owner: string) => Effect.Effect<boolean, Failure>;
}

/** Metadata and roots use Tables; external IO never holds a database transaction open. */
export const makeBlobStorage = Effect.fn("BlobStorage.open")(function* (
    options: BlobStorageOptions
): Effect.fn.Return<BlobStorageService, Failure, import("effect").Scope.Scope> {
    const { tables, bytes } = options;
    const owner = crypto.randomUUID();
    if (Boolean(options.registerOwner) !== Boolean(options.isOwnerAlive))
        return yield* blobFailure(
            "InvalidValue",
            "Owner registration and liveness must be supplied together."
        );
    if (options.registerOwner) yield* options.registerOwner(owner);
    const name = (suffix: string) => JSON.stringify(["ontology", options.namespace, "blobs", suffix]);
    const records = Table.make({
        name: name("metadata"),
        codec: {
            encode: Schema.encodeSync(BlobRecordSchema),
            decode: Schema.decodeUnknownSync(BlobRecordSchema),
        },
    });
    const roots = Table.make<{ owner: string; blob: string; process?: string }>({ name: name("roots") });
    const writes = Table.make<{ id: string; byteKey: string; owner: string }>({ name: name("writes") });
    const deletions = Table.make<{ byteKey: string }>({ name: name("deletions") });
    yield* tables.transaction((tx) =>
        Effect.gen(function* () {
            yield* tx.ensureIndex(records, { name: "remoteId", field: field("remoteId") });
            yield* tx.ensureIndex(records, { name: "accessed", field: field("lastAccessedAt") });
            yield* tx.ensureIndex(roots, { name: "owner", field: field("owner") });
            yield* tx.ensureIndex(roots, { name: "blob", field: field("blob") });
            yield* tx.ensureIndex(roots, { name: "process", field: field("process") });
        })
    );
    const find = Effect.fnUntraced(function* (tx: ReadTransaction, id: string) {
        return (
            (yield* tx.get(records, id)) ??
            (yield* tx.loadSubset(records, { where: eq(field("remoteId"), id), limit: 1 }))[0]?.value
        );
    });
    const rooted = (tx: ReadTransaction, id: string) =>
        Effect.map(
            tx.loadSubset(roots, { where: eq(field("blob"), id), limit: 1 }),
            (rows) => rows.length > 0
        );
    const release = Effect.fnUntraced(function* (tx: Transaction, rootOwner: string) {
        for (const row of yield* tx.loadSubset(roots, { where: eq(field("owner"), rootOwner) }))
            yield* tx.delete(roots, row.key);
    });
    const empty = (id: string, now: number): BlobRecord => ({
        id,
        remoteId: id,
        state: "cached",
        createdAt: now,
        updatedAt: now,
        lastAccessedAt: now,
    });
    const retention = (tx: Transaction): BlobRetentionTransaction => ({
        release: (rootOwner) => release(tx, rootOwner),
        retain: Effect.fnUntraced(function* (rootOwner: string, ids: readonly string[]) {
            const selected: BlobRecord[] = [];
            const now = yield* Clock.currentTimeMillis;
            for (const id of new Set(ids)) {
                if (!id) return yield* blobFailure("InvalidValue", "A blob handle needs an ID.");
                const record = (yield* find(tx, id)) ?? empty(id, now);
                if (record.writing) return yield* blobFailure("Busy", "Blob staging has not completed.");
                if (record.state === "staged" && !record.byteKey)
                    return yield* blobFailure("NotFound", "Staged bytes are unavailable.");
                selected.push(record);
            }
            yield* release(tx, rootOwner);
            for (const record of selected) {
                yield* tx.put(records, record.id, record);
                yield* tx.put(roots, JSON.stringify([rootOwner, record.id]), {
                    owner: rootOwner,
                    blob: record.id,
                });
            }
        }),
    });
    const io = <A>(work: Effect.Effect<A, unknown>) =>
        work.pipe(Effect.mapError((cause) => blobFailure("Bytes", "Blob byte storage failed.", cause)));
    const drain = Effect.fn("BlobStorage.deleteDetached")(function* () {
        // The key is never reused. Concurrent collectors may delete it repeatedly.
        for (const { key, value } of yield* tables.loadSubset(deletions, { limit: 100 })) {
            yield* io(bytes.delete(value.byteKey));
            yield* tables.delete(deletions, key);
        }
    });
    const abandon = (token: string) =>
        tables.transaction((tx) =>
            Effect.gen(function* () {
                const pending = yield* tx.get(writes, token);
                if (!pending) return;
                const record = yield* tx.get(records, pending.id);
                if (record?.writing === token)
                    yield* tx.put(records, record.id, { ...record, writing: undefined });
                yield* tx.put(deletions, pending.byteKey, { byteKey: pending.byteKey });
                yield* tx.delete(writes, token);
            })
        );
    const write = Effect.fn("BlobStorage.write")(function* (
        id: string,
        value: Blob,
        state: "staged" | "cached"
    ) {
        if (!id) return yield* blobFailure("InvalidValue", "A blob handle needs an ID.");
        const token = crypto.randomUUID();
        const byteKey = `party-stack:blob:${token}`;
        // Wait for an external write to settle even if its Promise ignores cancellation.
        // Then check cancellation before publishing it or queue its exact generation for cleanup.
        yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
                yield* tables.transaction((tx) =>
                    Effect.gen(function* () {
                        const now = yield* Clock.currentTimeMillis;
                        const previous = yield* find(tx, id);
                        if (previous?.writing)
                            return yield* blobFailure("Busy", "Another blob write is in progress.");
                        if (
                            previous &&
                            (yield* rooted(tx, previous.id)) &&
                            (state === "staged" || previous.byteKey)
                        )
                            return yield* blobFailure(
                                "Conflict",
                                "Referenced blob bytes cannot be replaced."
                            );
                        const record: BlobRecord = previous ?? {
                            ...empty(id, now),
                            remoteId: state === "cached" ? id : undefined,
                            state,
                        };
                        yield* tx.put(records, record.id, { ...record, writing: token });
                        yield* tx.put(writes, token, { id: record.id, byteKey, owner });
                    })
                );
                yield* Effect.gen(function* () {
                    yield* io(bytes.write(byteKey, value));
                    yield* restore(Effect.void);
                    yield* tables.transaction((tx) =>
                        Effect.gen(function* () {
                            const pending = yield* tx.get(writes, token);
                            const record = pending ? yield* tx.get(records, pending.id) : undefined;
                            if (!record || record.writing !== token)
                                return yield* blobFailure("Conflict", "Blob write was superseded.");
                            const now = yield* Clock.currentTimeMillis;
                            if (record.byteKey)
                                yield* tx.put(deletions, record.byteKey, { byteKey: record.byteKey });
                            yield* tx.put(records, record.id, {
                                ...record,
                                byteKey,
                                writing: undefined,
                                state,
                                size: value.size,
                                type: value.type || (state === "cached" ? (record.type ?? "") : ""),
                                name:
                                    state === "cached" && record.name !== undefined
                                        ? record.name
                                        : "name" in value && typeof value.name === "string"
                                          ? value.name
                                          : null,
                                updatedAt: now,
                                lastAccessedAt: now,
                            });
                            yield* tx.delete(writes, token);
                        })
                    );
                }).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : abandon(token))));
            })
        );
    });
    const recover = Effect.gen(function* () {
        if (options.isOwnerAlive)
            for (const { key, value } of yield* tables.loadSubset(writes)) {
                if (!(yield* options.isOwnerAlive(value.owner))) yield* abandon(String(key));
            }
        if (options.isOwnerAlive)
            for (const row of yield* tables.loadSubset(roots, { where: ne(field("process"), undefined) })) {
                if (row.value.process && !(yield* options.isOwnerAlive(row.value.process)))
                    yield* tables.delete(roots, row.key);
            }
        yield* drain();
    }).pipe(Effect.withSpan("BlobStorage.recover"));
    let gcCursor: Cursor | undefined;
    const service: BlobStorageService = {
        in: retention,
        metadata: (id) => tables.read((tx) => find(tx, id)),
        records: (query) => tables.loadSubset(records, query),
        stage: (id, value) => write(id, value, "staged"),
        cache: (id, value) => write(id, value, "cached"),
        read: Effect.fn("BlobStorage.read")(function* (id: string) {
            return yield* Effect.acquireUseRelease(
                tables.transaction((tx) =>
                    Effect.gen(function* () {
                        const record = yield* find(tx, id);
                        if (!record) return undefined;
                        if (record.writing)
                            return yield* blobFailure("Busy", "Blob staging has not completed.");
                        const rootOwner = `reader:${owner}:${crypto.randomUUID()}`;
                        yield* tx.put(roots, JSON.stringify([rootOwner, record.id]), {
                            owner: rootOwner,
                            blob: record.id,
                            process: owner,
                        });
                        yield* tx.put(records, record.id, {
                            ...record,
                            lastAccessedAt: yield* Clock.currentTimeMillis,
                        });
                        return { record, rootOwner };
                    })
                ),
                (acquired) =>
                    Effect.gen(function* () {
                        if (!acquired?.record.byteKey) return undefined;
                        const value = yield* io(bytes.read(acquired.record.byteKey));
                        if (value)
                            return typeof acquired.record.name === "string"
                                ? new File([value], acquired.record.name, {
                                      type: acquired.record.type ?? value.type,
                                  })
                                : new Blob([value], { type: acquired.record.type ?? value.type });
                        // A byte store can lose cache files independently. Detach only
                        // the generation we read, preserving the identity and its roots.
                        yield* tables.transaction((tx) =>
                            Effect.gen(function* () {
                                const record = yield* tx.get(records, acquired.record.id);
                                if (!record || record.byteKey !== acquired.record.byteKey) return;
                                yield* tx.put(records, record.id, { ...record, byteKey: undefined });
                                yield* tx.put(deletions, acquired.record.byteKey!, {
                                    byteKey: acquired.record.byteKey!,
                                });
                            })
                        );
                        return undefined;
                    }),
                (acquired) =>
                    acquired
                        ? tables.transaction((tx) => release(tx, acquired.rootOwner)).pipe(Effect.orDie)
                        : Effect.void
            );
        }),
        updateMetadata: Effect.fnUntraced(function* (id: string, input: BlobMetadata) {
            const metadata = yield* Schema.decodeUnknownEffect(BlobMetadataSchema)(input).pipe(
                Effect.mapError((cause) => blobFailure("InvalidValue", "Invalid blob metadata.", cause))
            );
            return yield* tables.transaction((tx) =>
                Effect.gen(function* () {
                    const now = yield* Clock.currentTimeMillis;
                    const record = {
                        ...((yield* find(tx, id)) ?? empty(id, now)),
                        ...metadata,
                        updatedAt: now,
                    };
                    yield* tx.put(records, record.id, record);
                    return record;
                })
            );
        }),
        bindRemoteId: (id, remoteId) =>
            tables.transaction((tx) =>
                Effect.gen(function* () {
                    const record = yield* find(tx, id);
                    if (!record) return yield* blobFailure("NotFound", "Cannot bind a missing blob.");
                    if (record.writing) return yield* blobFailure("Busy", "Blob staging has not completed.");
                    const other = yield* find(tx, remoteId);
                    if (other && other.id !== record.id)
                        return yield* blobFailure("Conflict", "Remote blob ID is already bound.");
                    if (record.remoteId && record.remoteId !== remoteId)
                        return yield* blobFailure(
                            "Conflict",
                            "Blob ID is already bound to another remote ID."
                        );
                    yield* tx.put(records, record.id, {
                        ...record,
                        remoteId,
                        state: "persisted",
                        updatedAt: yield* Clock.currentTimeMillis,
                    });
                })
            ),
        collectGarbage: Effect.fn("BlobStorage.collectGarbage")(function* ({
            olderThanMs,
            limit = 100,
        }: {
            olderThanMs: number;
            limit?: number;
        }) {
            if (!Number.isFinite(olderThanMs) || olderThanMs < 0 || !Number.isSafeInteger(limit) || limit < 1)
                return yield* blobFailure("InvalidValue", "Invalid blob GC policy.");
            const cutoff = (yield* Clock.currentTimeMillis) - olderThanMs;
            const count = yield* tables.transaction((tx) =>
                Effect.gen(function* () {
                    let count = 0;
                    const candidates = yield* tx.loadSubset(records, {
                        where: and(
                            lte(field("lastAccessedAt"), cutoff),
                            eq(field("writing"), undefined),
                            ne(field("byteKey"), undefined),
                            ne(field("remoteId"), undefined),
                            ne(field("state"), "staged")
                        ),
                        orderBy: [{ field: field("lastAccessedAt") }],
                        after: gcCursor,
                        limit,
                    });
                    const last = candidates.at(-1);
                    gcCursor =
                        candidates.length === limit && last
                            ? cursorOf(last, { orderBy: [{ field: field("lastAccessedAt") }] })
                            : undefined;
                    for (const { value: record } of candidates) {
                        if (
                            !record.byteKey ||
                            record.state === "staged" ||
                            !record.remoteId ||
                            (yield* rooted(tx, record.id))
                        )
                            continue;
                        yield* tx.put(deletions, record.byteKey, { byteKey: record.byteKey });
                        // Detach before IO. New readers see a miss and can cache a new immutable generation.
                        yield* tx.put(records, record.id, { ...record, byteKey: undefined });
                        count++;
                    }
                    return count;
                })
            );
            yield* drain();
            return count;
        }),
        recover,
    };
    return service;
});
