import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import type { BlobMetadataAdapter, BlobRef, BlobState } from "../types.js";

export interface ExpoSQLiteBlobMetadataAdapterOptions {
    databaseName?: string;
    directory?: string;
    tableName?: string;
}

interface BlobRefRow {
    id: string;
    remote_id: string | null;
    type: string;
    size: number;
    name: string | null;
    state: BlobState;
    last_accessed_at: number | null;
    created_at: number;
    updated_at: number;
    error: string | null;
}

function sqlIdentifier(name: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Invalid SQLite identifier "${name}".`);
    }
    return `"${name}"`;
}

function rowToBlobRef(row: BlobRefRow): BlobRef {
    return {
        id: row.id,
        remoteId: row.remote_id ?? undefined,
        type: row.type,
        size: row.size,
        name: row.name ?? undefined,
        state: row.state,
        lastAccessedAt: row.last_accessed_at ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        error: row.error ?? undefined,
    };
}

export class ExpoSQLiteBlobMetadataAdapter implements BlobMetadataAdapter {
    readonly databaseName: string;
    readonly directory: string | undefined;
    readonly tableName: string;
    private dbPromise?: Promise<SQLiteDatabase>;

    constructor(opts: ExpoSQLiteBlobMetadataAdapterOptions = {}) {
        this.databaseName = opts.databaseName ?? "party-stack-blobs.db";
        this.directory = opts.directory;
        this.tableName = opts.tableName ?? "blob_metadata";
    }

    private table(): string {
        return sqlIdentifier(this.tableName);
    }

    private indexName(suffix: string): string {
        return sqlIdentifier(`${this.tableName}_${suffix}`);
    }

    private db(): Promise<SQLiteDatabase> {
        this.dbPromise ??= openDatabaseAsync(this.databaseName, undefined, this.directory).then(
            async (db) => {
                const table = this.table();
                await db.execAsync(`
                    PRAGMA journal_mode = WAL;
                    CREATE TABLE IF NOT EXISTS ${table} (
                        id TEXT PRIMARY KEY NOT NULL,
                        remote_id TEXT,
                        type TEXT NOT NULL,
                        size INTEGER NOT NULL,
                        name TEXT,
                        state TEXT NOT NULL,
                        last_accessed_at INTEGER,
                        created_at INTEGER NOT NULL,
                        updated_at INTEGER NOT NULL,
                        error TEXT
                    );
                    CREATE INDEX IF NOT EXISTS ${this.indexName("state_idx")} ON ${table}(state);
                    CREATE INDEX IF NOT EXISTS ${this.indexName("last_accessed_at_idx")} ON ${table}(last_accessed_at);
                    CREATE INDEX IF NOT EXISTS ${this.indexName("updated_at_idx")} ON ${table}(updated_at);
                `);
                const columns = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
                const columnNames = new Set(columns.map((column) => column.name));
                if (!columnNames.has("remote_id")) {
                    await db.execAsync(`ALTER TABLE ${table} ADD COLUMN remote_id TEXT;`);
                }
                await db.execAsync(
                    `CREATE INDEX IF NOT EXISTS ${this.indexName("remote_id_idx")} ON ${table}(remote_id);`
                );
                return db;
            }
        );
        return this.dbPromise;
    }

    async put(ref: BlobRef): Promise<void> {
        const db = await this.db();
        await db.runAsync(
            `
                INSERT INTO ${this.table()} (
                    id,
                    remote_id,
                    type,
                    size,
                    name,
                    state,
                    last_accessed_at,
                    created_at,
                    updated_at,
                    error
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    remote_id = excluded.remote_id,
                    type = excluded.type,
                    size = excluded.size,
                    name = excluded.name,
                    state = excluded.state,
                    last_accessed_at = excluded.last_accessed_at,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    error = excluded.error
            `,
            [
                ref.id,
                ref.remoteId ?? null,
                ref.type,
                ref.size,
                ref.name ?? null,
                ref.state,
                ref.lastAccessedAt ?? null,
                ref.createdAt,
                ref.updatedAt,
                ref.error ?? null,
            ]
        );
    }

    async get(id: string): Promise<BlobRef | undefined> {
        const db = await this.db();
        const row = await db.getFirstAsync<BlobRefRow>(
            `SELECT * FROM ${this.table()} WHERE id = ?`,
            id
        );
        return row ? rowToBlobRef(row) : undefined;
    }

    async getByRemoteId(remoteId: string): Promise<BlobRef | undefined> {
        const db = await this.db();
        const row = await db.getFirstAsync<BlobRefRow>(
            `SELECT * FROM ${this.table()} WHERE remote_id = ?`,
            remoteId
        );
        return row ? rowToBlobRef(row) : undefined;
    }

    async list(opts?: { state?: BlobState }): Promise<BlobRef[]> {
        const db = await this.db();
        const rows = opts?.state
            ? await db.getAllAsync<BlobRefRow>(
                  `SELECT * FROM ${this.table()} WHERE state = ? ORDER BY created_at ASC`,
                  opts.state
              )
            : await db.getAllAsync<BlobRefRow>(
                  `SELECT * FROM ${this.table()} ORDER BY created_at ASC`
              );
        return rows.map(rowToBlobRef);
    }

    async delete(id: string): Promise<void> {
        const db = await this.db();
        await db.runAsync(`DELETE FROM ${this.table()} WHERE id = ?`, id);
    }
}
