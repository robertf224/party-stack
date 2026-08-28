import {
    createCloudflareDOSQLitePersistence,
    type DurableObjectStorageLike,
} from "@tanstack/cloudflare-durable-objects-db-sqlite-persistence";
import type { SQLiteDatabase } from "@party-stack/sqlite-ontology";
import { decodeRuntimeValue, encodeRuntimeValue } from "./runtimeValues.js";
import type { LoadSubsetOptions } from "@tanstack/db";
import type {
    PersistedIndexSpec,
    PersistedRowScanOptions,
    PersistedScannedRow,
    PersistedTx,
    PersistenceAdapter,
} from "@tanstack/db-sqlite-persistence-core";

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function sqlIdentifier(value: string): string {
    if (!SAFE_IDENTIFIER.test(value)) {
        throw new Error(`Invalid TanStack persistence identifier "${value}".`);
    }
    return `"${value}"`;
}

function encodeScopePart(value: string): string {
    let encoded = "";
    for (let index = 0; index < value.length; index++) {
        encoded += value.charCodeAt(index).toString(16).padStart(4, "0");
    }
    return encoded;
}

function encodeRuntimeRecord(value: Record<string, unknown>): Record<string, unknown> {
    return encodeRuntimeValue(value) as Record<string, unknown>;
}

function decodeRuntimeRecord(value: Record<string, unknown>): Record<string, unknown> {
    return decodeRuntimeValue(value) as Record<string, unknown>;
}

export class DurableObjectPersistenceAdapter implements PersistenceAdapter {
    private readonly adapter: PersistenceAdapter;

    constructor(
        readonly database: SQLiteDatabase,
        storage: DurableObjectStorageLike
    ) {
        this.adapter = createCloudflareDOSQLitePersistence({
            storage,
        }).adapter;
    }

    async loadSubset(
        collectionId: string,
        options: LoadSubsetOptions,
        context?: {
            requiredIndexSignatures?: ReadonlyArray<string>;
        }
    ) {
        const rows = await this.adapter.loadSubset(collectionId, options, context);
        return rows.map((row) => ({
            ...row,
            value: decodeRuntimeRecord(row.value),
            ...(row.metadata === undefined
                ? {}
                : {
                      metadata: decodeRuntimeValue(row.metadata),
                  }),
        }));
    }

    applyCommittedTx(collectionId: string, transaction: PersistedTx): Promise<void> {
        const encoded = {
            ...transaction,
            mutations: transaction.mutations.map((mutation) => ({
                ...mutation,
                value: encodeRuntimeRecord(mutation.value),
                ...("metadata" in mutation && mutation.metadata !== undefined
                    ? {
                          metadata: encodeRuntimeValue(mutation.metadata),
                      }
                    : {}),
            })),
            rowMetadataMutations: transaction.rowMetadataMutations?.map((mutation) =>
                mutation.type === "set"
                    ? {
                          ...mutation,
                          value: encodeRuntimeValue(mutation.value),
                      }
                    : mutation
            ),
            collectionMetadataMutations: transaction.collectionMetadataMutations?.map((mutation) =>
                mutation.type === "set"
                    ? {
                          ...mutation,
                          value: encodeRuntimeValue(mutation.value),
                      }
                    : mutation
            ),
        } as PersistedTx;
        return this.adapter.applyCommittedTx(collectionId, encoded);
    }

    async loadCollectionMetadata(collectionId: string): Promise<Array<{ key: string; value: unknown }>> {
        const rows = (await this.adapter.loadCollectionMetadata?.(collectionId)) ?? [];
        return rows.map((row) => ({
            key: row.key,
            value: decodeRuntimeValue(row.value),
        }));
    }

    async scanRows(
        collectionId: string,
        options?: PersistedRowScanOptions
    ): Promise<Array<PersistedScannedRow>> {
        const rows = (await this.adapter.scanRows?.(collectionId, options)) ?? [];
        return rows.map((row) => ({
            ...row,
            value: decodeRuntimeRecord(row.value),
            ...(row.metadata === undefined
                ? {}
                : {
                      metadata: decodeRuntimeValue(row.metadata),
                  }),
        }));
    }

    ensureIndex(collectionId: string, signature: string, spec: PersistedIndexSpec): Promise<void> {
        return this.adapter.ensureIndex(collectionId, signature, spec);
    }

    markIndexRemoved(collectionId: string, signature: string): Promise<void> {
        return this.adapter.markIndexRemoved?.(collectionId, signature) ?? Promise.resolve();
    }

    getStreamPosition(collectionId: string): Promise<{
        latestTerm: number;
        latestSeq: number;
        latestRowVersion: number;
    }> {
        return (
            this.adapter.getStreamPosition?.(collectionId) ??
            Promise.resolve({
                latestTerm: 0,
                latestSeq: 0,
                latestRowVersion: 0,
            })
        );
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
            applyCommittedTx: (collectionId, transaction) =>
                this.applyCommittedTx(map(collectionId), transaction),
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
        const registryExists =
            this.database
                .prepare(
                    `SELECT name
                     FROM sqlite_master
                     WHERE type = 'table' AND name = 'collection_registry'`
                )
                .get() !== undefined;
        if (!registryExists) return;

        const prefix = `party-stack:v2:${encodeScopePart(owner)}:${encodeScopePart(namespace)}:`;
        const collections = (
            this.database
                .prepare(
                    `SELECT collection_id, table_name, tombstone_table_name
                     FROM collection_registry`
                )
                .all() as Array<{
                collection_id: string;
                table_name: string;
                tombstone_table_name: string;
            }>
        ).filter((row) => row.collection_id.startsWith(prefix));
        this.database.transaction(() => {
            for (const collection of collections) {
                const indexes = this.database
                    .prepare(
                        `SELECT index_name
                         FROM persisted_index_registry
                         WHERE collection_id = ?`
                    )
                    .all(collection.collection_id) as Array<{
                    index_name: string;
                }>;
                for (const index of indexes) {
                    this.database.exec(`DROP INDEX IF EXISTS ${sqlIdentifier(index.index_name)}`);
                }
                this.database.exec(`DROP TABLE IF EXISTS ${sqlIdentifier(collection.table_name)}`);
                this.database.exec(`DROP TABLE IF EXISTS ${sqlIdentifier(collection.tombstone_table_name)}`);
                for (const table of [
                    "applied_tx",
                    "collection_version",
                    "collection_metadata",
                    "leader_term",
                    "collection_reset_epoch",
                    "persisted_index_registry",
                    "collection_registry",
                ]) {
                    this.database
                        .prepare(
                            `DELETE FROM ${table}
                             WHERE collection_id = ?`
                        )
                        .run(collection.collection_id);
                }
            }
        })();
    }
}
