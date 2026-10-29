import { Clock, Context, Effect, Exit, Layer, Schema, Stream } from "effect";
import { Table, eq, ne, field, lte, and, type Cursor } from "../model.js";
import { cursorOf } from "../query/evaluate.js";
import { Tables, type TablesService, type ReadTransaction, type Transaction } from "../tables.js";
import { byteSource, byteChunks, collectByteBlob, type ByteInput, type ByteSource } from "./bytes.js";
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
import type { Scope } from "effect";

export * from "./model.js";
export * from "./bytes.js";
export { exclusiveOwnerLiveness } from "./owners.js";
export { collectAttachments, collectActionAttachments, collectObjectAttachments } from "./attachments.js";
export type { AttachmentReference } from "./attachments.js";
type Failure = BlobStorageError | OntologyStorageError;
export interface BlobRetentionTransaction {
    /** Replace this owner's durable roots in the same transaction as its outbox entry. */
    readonly retain: (
        owner: string,
        ids: readonly string[],
        options?: { readonly bytes?: boolean; readonly group?: string }
    ) => Effect.Effect<void, Failure>;
    /** Validate transferred bytes in the transaction that accepts responsibility for them. */
    readonly requireBytes: (ids: readonly string[]) => Effect.Effect<void, Failure>;
    readonly bindRemoteId: (id: string, remoteId?: string) => Effect.Effect<void, Failure>;
    readonly releaseGroup: (group: string) => Effect.Effect<void, Failure>;
    readonly release: (owner: string) => Effect.Effect<void, Failure>;
}
export interface BlobStorageService {
    readonly in: (tx: Transaction) => BlobRetentionTransaction;
    readonly metadata: (id: string) => Effect.Effect<BlobRecord | undefined, Failure>;
    readonly records: (
        query?: import("../model.js").Query
    ) => Effect.Effect<import("../model.js").Row<BlobRecord>[], Failure>;
    readonly stage: (id: string, value: ByteInput) => Effect.Effect<void, Failure>;
    readonly cache: (id: string, value: ByteInput) => Effect.Effect<void, Failure>;
    /** File-backed content is valid within the caller's scope; consume streams before it closes. */
    readonly readScoped: (id: string) => Effect.Effect<ByteSource | undefined, Failure, Scope.Scope>;
    /** Materialized local read; safe to consume after this call completes. The caller handles misses. */
    readonly read: (id: string) => Effect.Effect<Blob | undefined, Failure>;
    readonly updateMetadata: (id: string, value: BlobMetadata) => Effect.Effect<BlobRecord, Failure>;
    readonly bindRemoteId: (id: string, remoteId?: string) => Effect.Effect<void, Failure>;
    readonly collectGarbage: (options: {
        readonly olderThanMs: number;
        /** Unreferenced identities and sole local copies expire after this grace period. */
        readonly orphanGraceMs?: number;
        readonly limit?: number;
    }) => Effect.Effect<number, Failure>;
    /** Retry detached generations and abandoned writes; unknown live owners are left alone. */
    readonly recover: Effect.Effect<void, Failure>;
}
export class BlobStorage extends Context.Service<BlobStorage, BlobStorageService>()(
    "@party-stack/ontology-storage/blobs/BlobStorage"
) {
    static readonly layer = (
        namespace: string,
        options?: Omit<BlobStorageOptions, "namespace" | "tables" | "bytes">
    ) =>
        Layer.effect(
            BlobStorage,
            Effect.gen(function* () {
                return yield* makeBlobStorage({
                    ...options,
                    namespace,
                    tables: yield* Tables,
                    bytes: yield* BlobBytes,
                });
            })
        );
}
export interface BlobStorageOptions {
    readonly namespace: string;
    readonly tables: TablesService;
    readonly bytes: BlobBytesService;
    /** Authoritative bytes are collectible only when their identity is unreferenced. */
    readonly mode?: "replica" | "authoritative";
    readonly registerOwner?: (owner: string) => Effect.Effect<void, Failure, Scope.Scope>;
    readonly isOwnerAlive?: (owner: string) => Effect.Effect<boolean, Failure>;
}

/** Metadata and roots use Tables; external IO never holds a database transaction open. */
export const makeBlobStorage = Effect.fn("BlobStorage.open")(function* (
    options: BlobStorageOptions
): Effect.fn.Return<BlobStorageService, Failure, Scope.Scope> {
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
    const roots = Table.make<{
        owner: string;
        blob: string;
        bytes: boolean;
        group?: string;
        process?: string;
    }>({ name: name("roots") });
    const writes = Table.make<{ id: string; byteKey: string; owner: string }>({ name: name("writes") });
    const deletions = Table.make<{ byteKey: string }>({ name: name("deletions") });
    yield* tables.transaction((tx) =>
        Effect.gen(function* () {
            yield* tx.ensureIndex(records, { name: "remoteId", field: field("remoteId") });
            yield* tx.ensureIndex(records, { name: "accessed", field: field("lastAccessedAt") });
            yield* tx.ensureIndex(records, { name: "unreferenced", field: field("unreferencedAt") });
            yield* tx.ensureIndex(roots, { name: "owner", field: field("owner") });
            yield* tx.ensureIndex(roots, { name: "blob", field: field("blob") });
            yield* tx.ensureIndex(roots, { name: "process", field: field("process") });
            yield* tx.ensureIndex(roots, { name: "group", field: field("group") });
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
    const refreshRetention = Effect.fnUntraced(function* (tx: Transaction, id: string) {
        const record = yield* tx.get(records, id);
        if (!record) return;
        const references = yield* tx.loadSubset(roots, { where: eq(field("blob"), id), limit: 1 });
        const byteReferences = yield* tx.loadSubset(roots, {
            where: and(eq(field("blob"), id), eq(field("bytes"), true)),
            limit: 1,
        });
        yield* tx.put(records, id, {
            ...record,
            unreferencedAt: references.length
                ? undefined
                : (record.unreferencedAt ?? (yield* Clock.currentTimeMillis)),
            bytesRetained: byteReferences.length > 0,
        });
    });
    const release = Effect.fnUntraced(function* (tx: Transaction, rootOwner: string) {
        const previous = yield* tx.loadSubset(roots, { where: eq(field("owner"), rootOwner) });
        for (const row of previous) yield* tx.delete(roots, row.key);
        for (const id of new Set(previous.map((row) => row.value.blob))) yield* refreshRetention(tx, id);
    });
    const bindRemoteId = Effect.fnUntraced(function* (tx: Transaction, id: string, remote?: string) {
        const record = yield* find(tx, id);
        if (!record) return yield* blobFailure("NotFound", "Cannot bind a missing blob.");
        const remoteId = remote ?? record.remoteId ?? id;
        if (!remoteId) return yield* blobFailure("InvalidValue", "A remote blob handle needs an ID.");
        if (record.writing) return yield* blobFailure("Busy", "Blob staging has not completed.");
        if (record.remoteId && record.remoteId !== remoteId)
            return yield* blobFailure("Conflict", "Blob ID is already bound to another remote ID.");
        const other = yield* find(tx, remoteId);
        if (other && other.id !== record.id) {
            // A concurrent read may have cached the remote identity before the receipt arrived.
            // Merge that placeholder, but never coalesce two independently staged identities.
            if (other.id !== remoteId || other.state === "staged" || other.writing)
                return yield* blobFailure("Conflict", "Remote blob ID is already bound.");
            const inherited = yield* tx.loadSubset(roots, { where: eq(field("blob"), other.id) });
            if (record.byteKey && other.byteKey && inherited.some((row) => row.value.process !== undefined))
                return yield* blobFailure("Busy", "Remote cached bytes are being read.");
            for (const row of inherited) {
                yield* tx.delete(roots, row.key);
                const rootKey = JSON.stringify([row.value.owner, record.id]);
                const existing = yield* tx.get(roots, rootKey);
                yield* tx.put(roots, rootKey, {
                    ...row.value,
                    blob: record.id,
                    bytes: row.value.bytes || existing?.bytes === true,
                });
            }
            if (other.byteKey && record.byteKey)
                yield* tx.put(deletions, other.byteKey, { byteKey: other.byteKey });
            yield* tx.delete(records, other.id);
        }
        yield* tx.put(records, record.id, {
            ...record,
            byteKey: record.byteKey ?? other?.byteKey,
            size: record.size ?? other?.size,
            type: record.type ?? other?.type,
            name: record.name ?? other?.name,
            dimensions: record.dimensions ?? other?.dimensions,
            remoteId,
            state: "persisted",
            updatedAt: yield* Clock.currentTimeMillis,
        });
        yield* refreshRetention(tx, record.id);
    });
    const empty = (id: string, now: number): BlobRecord => ({
        id,
        remoteId: id,
        state: "cached",
        createdAt: now,
        updatedAt: now,
        lastAccessedAt: now,
        unreferencedAt: now,
        bytesRetained: false,
    });
    const retention = (tx: Transaction): BlobRetentionTransaction => ({
        requireBytes: Effect.fnUntraced(function* (ids: readonly string[]) {
            for (const id of new Set(ids))
                if (!(yield* find(tx, id))?.byteKey)
                    return yield* blobFailure(
                        "NotFound",
                        "Required staged attachment bytes are unavailable."
                    );
        }),
        release: (rootOwner) => release(tx, rootOwner),
        releaseGroup: Effect.fnUntraced(function* (group: string) {
            const selected = yield* tx.loadSubset(roots, { where: eq(field("group"), group) });
            for (const row of selected) yield* tx.delete(roots, row.key);
            for (const id of new Set(selected.map((row) => row.value.blob))) yield* refreshRetention(tx, id);
        }),
        bindRemoteId: (id, remoteId) => bindRemoteId(tx, id, remoteId),
        retain: Effect.fnUntraced(function* (
            rootOwner: string,
            ids: readonly string[],
            settings?: { readonly bytes?: boolean; readonly group?: string }
        ) {
            const selected: BlobRecord[] = [];
            const now = yield* Clock.currentTimeMillis;
            for (const id of new Set(ids)) {
                if (!id) return yield* blobFailure("InvalidValue", "A blob handle needs an ID.");
                const record = (yield* find(tx, id)) ?? empty(id, now);
                if (options.mode === "authoritative" && !record.byteKey)
                    return yield* blobFailure("NotFound", "Authoritative attachment bytes are unavailable.");
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
                    bytes: settings?.bytes ?? true,
                    group: settings?.group,
                });
                yield* refreshRetention(tx, record.id);
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
        input: ByteInput,
        state: "staged" | "cached"
    ) {
        if (!id) return yield* blobFailure("InvalidValue", "A blob handle needs an ID.");
        const value = byteSource(input);
        if (value.size !== undefined && (!Number.isSafeInteger(value.size) || value.size < 0))
            return yield* blobFailure("InvalidValue", "Invalid attachment size.");
        let size = 0;
        let finished = false;
        const content: ByteSource = {
            ...value,
            stream: Stream.concat(
                byteChunks(value).pipe(
                    Stream.mapEffect((chunk) =>
                        Effect.gen(function* () {
                            size += chunk.length;
                            if (
                                !Number.isSafeInteger(size) ||
                                (value.size !== undefined && size > value.size)
                            )
                                return yield* blobFailure(
                                    "InvalidValue",
                                    "Attachment exceeds its declared size."
                                );
                            return chunk;
                        })
                    )
                ),
                Stream.fromEffect(
                    Effect.gen(function* () {
                        if (value.size !== undefined && size !== value.size)
                            return yield* blobFailure(
                                "InvalidValue",
                                "Attachment ended before its declared size."
                            );
                        finished = true;
                    })
                ).pipe(Stream.drain)
            ),
        };
        const token = crypto.randomUUID();
        const byteKey = `party-stack:blob:${token}`;
        // Byte stores cancel and settle IO before returning. Only the metadata handoff is uninterruptible.
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
                    yield* restore(io(bytes.write(byteKey, content)));
                    if (!finished)
                        return yield* blobFailure("Bytes", "Byte store did not consume the complete stream.");
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
                                size,
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
                    yield* tables.transaction((tx) => release(tx, row.value.owner));
            }
        yield* drain();
    }).pipe(Effect.withSpan("BlobStorage.recover"));
    let gcCursor: Cursor | undefined;
    let orphanCursor: Cursor | undefined;
    const service: BlobStorageService = {
        in: retention,
        metadata: (id) => tables.read((tx) => find(tx, id)),
        records: (query) => tables.loadSubset(records, query),
        stage: (id, value) => write(id, value, "staged"),
        cache: (id, value) => write(id, value, "cached"),
        readScoped: Effect.fn("BlobStorage.readScoped")(function* (id: string) {
            const acquired = yield* Effect.acquireRelease(
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
                            bytes: true,
                        });
                        yield* tx.put(records, record.id, {
                            ...record,
                            bytesRetained: true,
                            unreferencedAt: undefined,
                            lastAccessedAt: yield* Clock.currentTimeMillis,
                        });
                        return { record, rootOwner };
                    })
                ),
                (acquired) =>
                    acquired
                        ? tables.transaction((tx) => release(tx, acquired.rootOwner)).pipe(Effect.orDie)
                        : Effect.void
            );
            return yield* Effect.gen(function* () {
                if (!acquired?.record.byteKey) return undefined;
                const value = yield* io(bytes.read(acquired.record.byteKey));
                if (value)
                    return {
                        ...byteSource(value),
                        size: acquired.record.size ?? byteSource(value).size,
                        type: acquired.record.type ?? byteSource(value).type,
                        name: acquired.record.name ?? byteSource(value).name,
                    };
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
            });
        }),
        read: (id) =>
            Effect.scoped(
                Effect.gen(function* () {
                    const blob = yield* service.readScoped(id);
                    if (!blob) return undefined;
                    return yield* io(collectByteBlob(blob));
                })
            ).pipe(Effect.withSpan("BlobStorage.read")),
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
        bindRemoteId: (id, remoteId) => tables.transaction((tx) => bindRemoteId(tx, id, remoteId)),
        collectGarbage: Effect.fn("BlobStorage.collectGarbage")(function* ({
            olderThanMs,
            limit = 100,
            orphanGraceMs = 60 * 60_000,
        }: {
            olderThanMs: number;
            orphanGraceMs?: number;
            limit?: number;
        }) {
            if (
                !Number.isFinite(olderThanMs) ||
                olderThanMs < 0 ||
                !Number.isFinite(orphanGraceMs) ||
                orphanGraceMs < 0 ||
                !Number.isSafeInteger(limit) ||
                limit < 1
            )
                return yield* blobFailure("InvalidValue", "Invalid blob GC policy.");
            const now = yield* Clock.currentTimeMillis;
            const cutoff = now - olderThanMs;
            const count = yield* tables.transaction((tx) =>
                Effect.gen(function* () {
                    let count = 0;
                    const orphans = yield* tx.loadSubset(records, {
                        where: and(
                            lte(field("unreferencedAt"), now - orphanGraceMs),
                            ne(field("unreferencedAt"), undefined),
                            eq(field("writing"), undefined)
                        ),
                        orderBy: [{ field: field("unreferencedAt") }],
                        after: orphanCursor,
                        limit,
                    });
                    const lastOrphan = orphans.at(-1);
                    orphanCursor =
                        orphans.length === limit && lastOrphan
                            ? cursorOf(lastOrphan, { orderBy: [{ field: field("unreferencedAt") }] })
                            : undefined;
                    for (const { value: record } of orphans) {
                        if (yield* rooted(tx, record.id)) continue;
                        if (record.byteKey)
                            yield* tx.put(deletions, record.byteKey, { byteKey: record.byteKey });
                        yield* tx.delete(records, record.id);
                        count++;
                    }
                    if (options.mode === "authoritative") return count;
                    const candidates = yield* tx.loadSubset(records, {
                        where: and(
                            lte(field("lastAccessedAt"), cutoff),
                            eq(field("writing"), undefined),
                            ne(field("byteKey"), undefined),
                            ne(field("remoteId"), undefined),
                            ne(field("state"), "staged"),
                            ne(field("bytesRetained"), true)
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
                            (yield* tx.loadSubset(roots, {
                                where: and(eq(field("blob"), record.id), eq(field("bytes"), true)),
                                limit: 1,
                            })).length > 0
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
