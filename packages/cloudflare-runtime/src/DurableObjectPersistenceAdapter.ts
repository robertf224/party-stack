import { decodePersistedStorageKey, encodePersistedStorageKey } from "@tanstack/db-sqlite-persistence-core";
import { Temporal } from "temporal-polyfill";
import type { SQLiteDatabase } from "@party-stack/sqlite-ontology";
import type { LoadSubsetOptions } from "@tanstack/db";
import type {
    PersistedIndexSpec,
    PersistedRowScanOptions,
    PersistedScannedRow,
    PersistedTx,
    PersistenceAdapter,
} from "@tanstack/db-sqlite-persistence-core";

type EncodedValue =
    | { type: "array"; value: EncodedValue[] }
    | { type: "bigint"; value: string }
    | { type: "boolean"; value: boolean }
    | { type: "date"; value: string }
    | {
          type: "hole" | "infinity" | "nan" | "negative-infinity" | "null" | "undefined";
      }
    | { type: "number"; value: number }
    | {
          type: "object";
          value: Record<string, EncodedValue>;
      }
    | { type: "string"; value: string }
    | {
          type: "temporal-instant" | "temporal-plain-date";
          value: string;
      };

function encodeValueNode(value: unknown): EncodedValue {
    if (value === undefined) return { type: "undefined" };
    if (value === null) return { type: "null" };
    if (typeof value === "string") {
        return { type: "string", value };
    }
    if (typeof value === "boolean") {
        return { type: "boolean", value };
    }
    if (typeof value === "bigint") {
        return {
            type: "bigint",
            value: value.toString(),
        };
    }
    if (typeof value === "number") {
        if (Number.isNaN(value)) return { type: "nan" };
        if (value === Number.POSITIVE_INFINITY) {
            return { type: "infinity" };
        }
        if (value === Number.NEGATIVE_INFINITY) {
            return { type: "negative-infinity" };
        }
        return { type: "number", value };
    }
    if (value instanceof Date) {
        return {
            type: "date",
            value: value.toISOString(),
        };
    }
    const tag =
        value && typeof value === "object"
            ? (
                  value as {
                      [Symbol.toStringTag]?: unknown;
                  }
              )[Symbol.toStringTag]
            : undefined;
    if (tag === "Temporal.Instant") {
        return {
            type: "temporal-instant",
            value: (value as Temporal.Instant).toString(),
        };
    }
    if (tag === "Temporal.PlainDate") {
        return {
            type: "temporal-plain-date",
            value: (value as Temporal.PlainDate).toString(),
        };
    }
    if (Array.isArray(value)) {
        return {
            type: "array",
            value: Array.from({ length: value.length }, (_entry, index) =>
                index in value ? encodeValueNode(value[index]) : { type: "hole" }
            ),
        };
    }
    if (value && typeof value === "object") {
        return {
            type: "object",
            value: Object.fromEntries(
                Object.entries(value).map(([key, entry]) => [key, encodeValueNode(entry)])
            ),
        };
    }
    throw new TypeError(`Unsupported persisted runtime value: ${typeof value}.`);
}

function decodeValueNode(value: EncodedValue): unknown {
    switch (value.type) {
        case "undefined":
            return undefined;
        case "hole":
            return undefined;
        case "null":
            return null;
        case "string":
        case "boolean":
        case "number":
            return value.value;
        case "bigint":
            return BigInt(value.value);
        case "nan":
            return Number.NaN;
        case "infinity":
            return Number.POSITIVE_INFINITY;
        case "negative-infinity":
            return Number.NEGATIVE_INFINITY;
        case "date":
            return new Date(value.value);
        case "temporal-instant":
            return Temporal.Instant.from(value.value);
        case "temporal-plain-date":
            return Temporal.PlainDate.from(value.value);
        case "array":
            return value.value.reduce<unknown[]>((entries, entry, index) => {
                if (entry.type !== "hole") {
                    entries[index] = decodeValueNode(entry);
                }
                return entries;
            }, new Array(value.value.length));
        case "object":
            return Object.fromEntries(
                Object.entries(value.value).map(([key, entry]) => [key, decodeValueNode(entry)])
            );
    }
}

function encodeValue(value: unknown): string {
    return JSON.stringify(encodeValueNode(value));
}

function decodeValue(value: string): unknown {
    return decodeValueNode(JSON.parse(value) as EncodedValue);
}

function mergeValues(current: unknown, update: Record<string, unknown>): Record<string, unknown> {
    return current && typeof current === "object" && !Array.isArray(current)
        ? {
              ...(current as Record<string, unknown>),
              ...update,
          }
        : update;
}

function encodeScopePart(value: string): string {
    let encoded = "";
    for (let index = 0; index < value.length; index++) {
        encoded += value.charCodeAt(index).toString(16).padStart(4, "0");
    }
    return encoded;
}

export class DurableObjectPersistenceAdapter implements PersistenceAdapter {
    constructor(readonly database: SQLiteDatabase) {
        database.transaction(() => {
            database.exec(`
                CREATE TABLE IF NOT EXISTS party_stack_runtime_collections (
                    collection_id TEXT PRIMARY KEY,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS party_stack_runtime_rows (
                    collection_id TEXT NOT NULL,
                    key TEXT NOT NULL,
                    value TEXT NOT NULL,
                    metadata TEXT,
                    PRIMARY KEY (collection_id, key)
                );
                CREATE TABLE IF NOT EXISTS party_stack_runtime_transactions (
                    collection_id TEXT NOT NULL,
                    term INTEGER NOT NULL,
                    seq INTEGER NOT NULL,
                    tx_id TEXT NOT NULL,
                    PRIMARY KEY (collection_id, term, seq)
                );
                CREATE TABLE IF NOT EXISTS party_stack_runtime_metadata (
                    collection_id TEXT NOT NULL,
                    key TEXT NOT NULL,
                    value TEXT NOT NULL,
                    PRIMARY KEY (collection_id, key)
                );
                CREATE TABLE IF NOT EXISTS party_stack_runtime_streams (
                    collection_id TEXT PRIMARY KEY,
                    latest_term INTEGER NOT NULL,
                    latest_seq INTEGER NOT NULL,
                    latest_row_version INTEGER NOT NULL
                )
            `);
        })();
    }

    loadSubset(
        collectionId: string,
        _options: LoadSubsetOptions,
        _context?: {
            requiredIndexSignatures?: ReadonlyArray<string>;
        }
    ): Promise<
        Array<{
            key: string | number;
            value: Record<string, unknown>;
            metadata?: unknown;
        }>
    > {
        void _options;
        void _context;
        const rows = this.database
            .prepare(
                `SELECT key, value, metadata
                 FROM party_stack_runtime_rows
                 WHERE collection_id = ?`
            )
            .all(collectionId) as Array<{
            key: string;
            value: string;
            metadata: string | null;
        }>;
        return Promise.resolve(
            rows.map((row) => ({
                key: decodePersistedStorageKey(row.key),
                value: decodeValue(row.value) as Record<string, unknown>,
                ...(row.metadata === null
                    ? {}
                    : {
                          metadata: decodeValue(row.metadata),
                      }),
            }))
        );
    }

    applyCommittedTx(collectionId: string, tx: PersistedTx): Promise<void> {
        this.database.transaction(() => {
            const applied = this.database
                .prepare(
                    `SELECT 1
                     FROM party_stack_runtime_transactions
                     WHERE collection_id = ? AND term = ? AND seq = ?`
                )
                .get(collectionId, tx.term, tx.seq);
            if (applied) return;

            this.database
                .prepare(
                    `INSERT INTO party_stack_runtime_collections (
                        collection_id, updated_at
                     ) VALUES (?, ?)
                     ON CONFLICT(collection_id) DO UPDATE SET
                        updated_at = excluded.updated_at`
                )
                .run(collectionId, Date.now());
            if (tx.truncate) {
                this.database
                    .prepare(
                        `DELETE FROM party_stack_runtime_rows
                         WHERE collection_id = ?`
                    )
                    .run(collectionId);
            }
            for (const mutation of tx.mutations) {
                const key = encodePersistedStorageKey(mutation.key);
                if (mutation.type === "delete") {
                    this.database
                        .prepare(
                            `DELETE FROM party_stack_runtime_rows
                             WHERE collection_id = ? AND key = ?`
                        )
                        .run(collectionId, key);
                    continue;
                }
                const current = this.database
                    .prepare(
                        `SELECT value, metadata
                         FROM party_stack_runtime_rows
                         WHERE collection_id = ? AND key = ?`
                    )
                    .get(collectionId, key) as
                    | {
                          value: string;
                          metadata: string | null;
                      }
                    | undefined;
                const value =
                    mutation.type === "update"
                        ? mergeValues(current ? decodeValue(current.value) : undefined, mutation.value)
                        : mutation.value;
                const metadata =
                    mutation.metadataChanged || mutation.type === "insert"
                        ? mutation.metadata
                        : current?.metadata
                          ? decodeValue(current.metadata)
                          : undefined;
                this.database
                    .prepare(
                        `INSERT INTO party_stack_runtime_rows (
                            collection_id, key, value, metadata
                         ) VALUES (?, ?, ?, ?)
                         ON CONFLICT(collection_id, key) DO UPDATE SET
                            value = excluded.value,
                            metadata = excluded.metadata`
                    )
                    .run(
                        collectionId,
                        key,
                        encodeValue(value),
                        metadata === undefined ? null : encodeValue(metadata)
                    );
            }
            for (const mutation of tx.rowMetadataMutations ?? []) {
                const key = encodePersistedStorageKey(mutation.key);
                this.database
                    .prepare(
                        `UPDATE party_stack_runtime_rows
                         SET metadata = ?
                         WHERE collection_id = ? AND key = ?`
                    )
                    .run(mutation.type === "delete" ? null : encodeValue(mutation.value), collectionId, key);
            }
            for (const mutation of tx.collectionMetadataMutations ?? []) {
                if (mutation.type === "delete") {
                    this.database
                        .prepare(
                            `DELETE FROM party_stack_runtime_metadata
                             WHERE collection_id = ? AND key = ?`
                        )
                        .run(collectionId, mutation.key);
                } else {
                    this.database
                        .prepare(
                            `INSERT INTO party_stack_runtime_metadata (
                                collection_id, key, value
                             ) VALUES (?, ?, ?)
                             ON CONFLICT(collection_id, key) DO UPDATE SET
                                value = excluded.value`
                        )
                        .run(collectionId, mutation.key, encodeValue(mutation.value));
                }
            }
            this.database
                .prepare(
                    `INSERT INTO party_stack_runtime_transactions (
                        collection_id, term, seq, tx_id
                     ) VALUES (?, ?, ?, ?)`
                )
                .run(collectionId, tx.term, tx.seq, tx.txId);
            this.database
                .prepare(
                    `DELETE FROM party_stack_runtime_transactions
                     WHERE rowid IN (
                        SELECT rowid
                        FROM party_stack_runtime_transactions
                        WHERE collection_id = ?
                        ORDER BY term DESC, seq DESC
                        LIMIT -1 OFFSET 1000
                     )`
                )
                .run(collectionId);
            this.database
                .prepare(
                    `INSERT INTO party_stack_runtime_streams (
                        collection_id, latest_term, latest_seq,
                        latest_row_version
                     ) VALUES (?, ?, ?, ?)
                     ON CONFLICT(collection_id) DO UPDATE SET
                        latest_term = excluded.latest_term,
                        latest_seq = excluded.latest_seq,
                        latest_row_version = excluded.latest_row_version`
                )
                .run(collectionId, tx.term, tx.seq, tx.rowVersion);
        })();
        return Promise.resolve();
    }

    loadCollectionMetadata(collectionId: string): Promise<Array<{ key: string; value: unknown }>> {
        const rows = this.database
            .prepare(
                `SELECT key, value
                 FROM party_stack_runtime_metadata
                 WHERE collection_id = ?`
            )
            .all(collectionId) as Array<{
            key: string;
            value: string;
        }>;
        return Promise.resolve(
            rows.map((row) => ({
                key: row.key,
                value: decodeValue(row.value),
            }))
        );
    }

    scanRows(collectionId: string, _options?: PersistedRowScanOptions): Promise<Array<PersistedScannedRow>> {
        void _options;
        return this.loadSubset(collectionId, {});
    }

    ensureIndex(_collectionId: string, _signature: string, _spec: PersistedIndexSpec): Promise<void> {
        void _collectionId;
        void _signature;
        void _spec;
        return Promise.resolve();
    }

    markIndexRemoved(_collectionId?: string, _signature?: string): Promise<void> {
        void _collectionId;
        void _signature;
        return Promise.resolve();
    }

    getStreamPosition(collectionId: string): Promise<{
        latestTerm: number;
        latestSeq: number;
        latestRowVersion: number;
    }> {
        const row = this.database
            .prepare(
                `SELECT latest_term, latest_seq, latest_row_version
                 FROM party_stack_runtime_streams
                 WHERE collection_id = ?`
            )
            .get(collectionId) as
            | {
                  latest_term: number;
                  latest_seq: number;
                  latest_row_version: number;
              }
            | undefined;
        return Promise.resolve({
            latestTerm: Number(row?.latest_term ?? 0),
            latestSeq: Number(row?.latest_seq ?? 0),
            latestRowVersion: Number(row?.latest_row_version ?? 0),
        });
    }

    scoped(owner: string, namespace: string): PersistenceAdapter {
        const logicalPrefix = `party-stack:${owner}:${namespace}:`;
        const physicalPrefix = `party-stack:v2:${encodeScopePart(owner)}:${encodeScopePart(namespace)}:`;
        const map = (collectionId: string) => {
            if (!collectionId.startsWith(logicalPrefix)) {
                throw new Error(
                    `Runtime collection "${collectionId}" is outside scope "${owner}/${namespace}".`
                );
            }
            return `${physicalPrefix}${encodeScopePart(collectionId.slice(logicalPrefix.length))}`;
        };
        return {
            loadSubset: (collectionId, options, context) =>
                this.loadSubset(map(collectionId), options, context),
            applyCommittedTx: (collectionId, tx) => this.applyCommittedTx(map(collectionId), tx),
            loadCollectionMetadata: (collectionId) => this.loadCollectionMetadata(map(collectionId)),
            scanRows: (collectionId, options) => this.scanRows(map(collectionId), options),
            ensureIndex: (collectionId, signature, spec) =>
                this.ensureIndex(map(collectionId), signature, spec),
            markIndexRemoved: (collectionId, signature) =>
                this.markIndexRemoved(map(collectionId), signature),
            getStreamPosition: (collectionId) => this.getStreamPosition(map(collectionId)),
        };
    }

    destroyNamespace(owner: string, namespace: string): void {
        const prefix = `party-stack:v2:${encodeScopePart(owner)}:${encodeScopePart(namespace)}:`;
        const collectionIds = (
            this.database
                .prepare(
                    `SELECT collection_id
                     FROM party_stack_runtime_collections`
                )
                .all() as Array<{
                collection_id: string;
            }>
        )
            .map((row) => row.collection_id)
            .filter((id) => id.startsWith(prefix));
        this.database.transaction(() => {
            for (const collectionId of collectionIds) {
                for (const table of [
                    "party_stack_runtime_rows",
                    "party_stack_runtime_transactions",
                    "party_stack_runtime_metadata",
                    "party_stack_runtime_streams",
                    "party_stack_runtime_collections",
                ]) {
                    this.database
                        .prepare(
                            `DELETE FROM ${table}
                             WHERE collection_id = ?`
                        )
                        .run(collectionId);
                }
            }
        })();
    }
}
