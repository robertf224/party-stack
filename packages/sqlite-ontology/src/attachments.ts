import { encodeLegacySQLiteIdentifierPart, SQLiteNamespaceCollisionError } from "./namespace.js";
import type { SQLiteDatabase } from "./database.js";

const ATTACHMENT_MIGRATION_NAMESPACE = "__party_stack_attachments__";
const ATTACHMENT_SCHEMA_VERSION = 1;

function ensureInternalMigrationTable(database: SQLiteDatabase): void {
    database.exec(`
        CREATE TABLE IF NOT EXISTS party_stack_migrations (
            namespace TEXT NOT NULL,
            version INTEGER NOT NULL,
            name TEXT NOT NULL,
            applied_at INTEGER NOT NULL,
            PRIMARY KEY (namespace, version)
        )
    `);
}

function getAttachmentMigrationVersion(database: SQLiteDatabase): number {
    ensureInternalMigrationTable(database);
    const row = database
        .prepare(
            `SELECT COALESCE(MAX(version), 0) AS version
             FROM party_stack_migrations
             WHERE namespace = ?`
        )
        .get(ATTACHMENT_MIGRATION_NAMESPACE) as { version?: number } | undefined;
    return Number(row?.version ?? 0);
}

export class LegacySQLiteAttachmentMigrationRequiredError extends Error {
    constructor(readonly rowCount: number) {
        super(
            `The legacy SQLite attachment table contains ${rowCount} row(s) without an ontology namespace. ` +
                "Pass legacyAttachmentSqlNamespace explicitly to migrate them."
        );
        this.name = "LegacySQLiteAttachmentMigrationRequiredError";
    }
}

export class SQLiteAttachmentNotFoundError extends Error {
    constructor(
        readonly ontology: string,
        readonly attachmentId: string
    ) {
        super(`Attachment "${attachmentId}" was not found in SQLite ontology namespace "${ontology}".`);
        this.name = "SQLiteAttachmentNotFoundError";
    }
}

export interface SQLiteAttachmentBytesStore {
    write(id: string, blob: Blob): Promise<void>;
    read(id: string): Promise<Blob>;
    delete(id: string): Promise<void>;
}

export interface SQLiteExternalAttachmentStorage {
    bytes: SQLiteAttachmentBytesStore;
    keyPrefix?: string;
}

export interface SQLiteAttachmentStorageOptions {
    external?: SQLiteExternalAttachmentStorage;
    legacyAttachmentSqlNamespace?: string;
}

export interface SQLitePreparedAttachment {
    id: string;
    blob: Blob;
    bytes: Uint8Array | null;
    storageKey: string | null;
    intentToken: string | null;
    type: string;
    name: string | null;
    size: number;
    createdAt: number;
    updatedAt: number;
}

export interface SQLiteStoredAttachment {
    id: string;
    ontology: string;
    bytes: unknown;
    storage_key: string | null;
    type: string;
    name: string | null;
    size: number;
    created_at: number;
    updated_at: number;
}

interface AttachmentTableColumn {
    name: string;
    notnull: number;
    pk: number;
}

function createAttachmentTable(database: SQLiteDatabase, tableName = "party_stack_attachments"): void {
    database.exec(`
        CREATE TABLE "${tableName}" (
            ontology TEXT NOT NULL,
            id TEXT NOT NULL,
            bytes BLOB,
            storage_key TEXT,
            type TEXT NOT NULL,
            name TEXT,
            size INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (ontology, id),
            CHECK (
                (bytes IS NOT NULL AND storage_key IS NULL) OR
                (bytes IS NULL AND storage_key IS NOT NULL)
            )
        )
    `);
}

function attachmentTableExists(database: SQLiteDatabase): boolean {
    return (
        database
            .prepare(
                `SELECT name
                 FROM sqlite_master
                 WHERE type = 'table' AND name = ?`
            )
            .get("party_stack_attachments") !== undefined
    );
}

function attachmentColumns(database: SQLiteDatabase): AttachmentTableColumn[] {
    return database.prepare(`PRAGMA table_info("party_stack_attachments")`).all() as AttachmentTableColumn[];
}

function isCurrentAttachmentSchema(columns: readonly AttachmentTableColumn[]): boolean {
    const ontology = columns.find((column) => column.name === "ontology");
    const id = columns.find((column) => column.name === "id");
    const bytes = columns.find((column) => column.name === "bytes");
    return (
        ontology?.pk === 1 &&
        id?.pk === 2 &&
        bytes?.notnull === 0 &&
        columns.some((column) => column.name === "storage_key")
    );
}

function migrateAttachmentTable(options: {
    database: SQLiteDatabase;
    legacyAttachmentSqlNamespace?: string;
}): void {
    if (!attachmentTableExists(options.database)) {
        createAttachmentTable(options.database);
        return;
    }
    const columns = attachmentColumns(options.database);
    if (isCurrentAttachmentSchema(columns)) {
        return;
    }

    const hasOntology = columns.some((column) => column.name === "ontology");
    const hasStorageKey = columns.some((column) => column.name === "storage_key");
    if (hasOntology) {
        const owners = options.database
            .prepare(
                `SELECT DISTINCT ontology
                 FROM party_stack_attachments`
            )
            .all() as Array<{
            ontology: string;
        }>;
        const physicalOwners = new Map<string, string[]>();
        for (const owner of owners) {
            const physical = encodeLegacySQLiteIdentifierPart(owner.ontology).toLowerCase();
            const claimed = physicalOwners.get(physical) ?? [];
            claimed.push(owner.ontology);
            physicalOwners.set(physical, claimed);
        }
        for (const [physical, claimed] of physicalOwners) {
            if (new Set(claimed).size > 1) {
                throw new SQLiteNamespaceCollisionError(physical, claimed);
            }
        }
    }
    const count = options.database
        .prepare(
            `SELECT COUNT(*) AS count
             FROM party_stack_attachments`
        )
        .get() as { count: number };
    const rowCount = Number(count.count);
    if (!hasOntology && rowCount > 0 && !options.legacyAttachmentSqlNamespace) {
        throw new LegacySQLiteAttachmentMigrationRequiredError(rowCount);
    }

    options.database.exec(`DROP TABLE IF EXISTS "party_stack_attachments__migrating"`);
    createAttachmentTable(options.database, "party_stack_attachments__migrating");
    const insert = options.database.prepare(`
        INSERT INTO "party_stack_attachments__migrating" (
            ontology, id, bytes, storage_key, type, name, size,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // The port exposes materialized rows rather than a streaming cursor.
    // Copy one BLOB at a time to bound migration memory by the largest
    // individual attachment instead of total database size.
    let lastId: string | null = null;
    for (let copied = 0; copied < rowCount; copied++) {
        const rows = options.database
            .prepare(
                `SELECT *
                 FROM party_stack_attachments
                 WHERE (? IS NULL OR id > ?)
                 ORDER BY id
                 LIMIT 1`
            )
            .all(lastId, lastId) as Array<Record<string, unknown>>;
        if (rows.length !== 1) {
            throw new Error("Legacy attachment migration could not advance its keyset cursor.");
        }
        for (const row of rows) {
            const legacyOntology = hasOntology ? row.ontology : options.legacyAttachmentSqlNamespace;
            if (typeof legacyOntology !== "string") {
                throw new LegacySQLiteAttachmentMigrationRequiredError(rowCount);
            }
            // PR #114 stored raw adapter names in this column. Safe
            // identifiers and already-encoded namespaces remain unchanged;
            // unsafe names are deterministically restored to their legacy
            // physical namespace.
            const ontology = hasOntology ? encodeLegacySQLiteIdentifierPart(legacyOntology) : legacyOntology;
            insert.run(
                ontology,
                row.id,
                row.bytes ?? null,
                hasStorageKey ? (row.storage_key ?? null) : null,
                row.type,
                row.name ?? null,
                row.size,
                row.created_at,
                row.updated_at
            );
            lastId = String(row.id);
        }
    }
    options.database.exec(`
        DROP TABLE "party_stack_attachments";
        ALTER TABLE "party_stack_attachments__migrating"
        RENAME TO "party_stack_attachments"
    `);
}

export function ensureSQLiteAttachmentSchema(options: {
    database: SQLiteDatabase;
    legacyAttachmentSqlNamespace?: string;
}): void {
    ensureInternalMigrationTable(options.database);
    const version = getAttachmentMigrationVersion(options.database);
    if (version > ATTACHMENT_SCHEMA_VERSION) {
        throw new Error(
            `SQLite attachment schema version ${version} is newer than supported version ${ATTACHMENT_SCHEMA_VERSION}.`
        );
    }
    if (version < ATTACHMENT_SCHEMA_VERSION) {
        migrateAttachmentTable(options);
        options.database
            .prepare(
                `INSERT INTO party_stack_migrations (
                    namespace, version, name, applied_at
                 ) VALUES (?, ?, ?, ?)`
            )
            .run(
                ATTACHMENT_MIGRATION_NAMESPACE,
                ATTACHMENT_SCHEMA_VERSION,
                "attachments-composite-external-storage",
                Date.now()
            );
    } else if (
        !attachmentTableExists(options.database) ||
        !isCurrentAttachmentSchema(attachmentColumns(options.database))
    ) {
        throw new Error("SQLite attachment migration ledger does not match the attachment table schema.");
    }
    options.database.exec(`
        CREATE TABLE IF NOT EXISTS party_stack_attachment_orphans (
            storage_key TEXT PRIMARY KEY,
            ontology TEXT NOT NULL,
            attachment_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            state TEXT NOT NULL DEFAULT 'pending',
            intent_token TEXT,
            claim_token TEXT,
            claimed_at INTEGER
        )
    `);
    const orphanColumns = options.database
        .prepare(`PRAGMA table_info("party_stack_attachment_orphans")`)
        .all() as Array<{ name: string }>;
    if (!orphanColumns.some((column) => column.name === "state")) {
        options.database.exec(`
            ALTER TABLE party_stack_attachment_orphans
            ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'
        `);
    }
    if (!orphanColumns.some((column) => column.name === "intent_token")) {
        options.database.exec(`
            ALTER TABLE party_stack_attachment_orphans
            ADD COLUMN intent_token TEXT
        `);
        options.database.exec(`
            UPDATE party_stack_attachment_orphans
            SET intent_token = lower(hex(randomblob(16)))
            WHERE intent_token IS NULL
        `);
    }
    if (!orphanColumns.some((column) => column.name === "claim_token")) {
        options.database.exec(`
            ALTER TABLE party_stack_attachment_orphans
            ADD COLUMN claim_token TEXT
        `);
    }
    if (!orphanColumns.some((column) => column.name === "claimed_at")) {
        options.database.exec(`
            ALTER TABLE party_stack_attachment_orphans
            ADD COLUMN claimed_at INTEGER
        `);
    }
}

function encodeKeyPart(value: string): string {
    let encoded = "";
    for (let index = 0; index < value.length; index++) {
        encoded += value.charCodeAt(index).toString(16).padStart(4, "0");
    }
    return encoded;
}

export function createSQLiteAttachmentStorageKey(
    ontology: string,
    attachmentId: string,
    prefix = "party-stack/attachments",
    contentDigest?: string,
    generation?: string
): string {
    return [
        prefix,
        encodeKeyPart(ontology),
        encodeKeyPart(attachmentId),
        ...(contentDigest ? [contentDigest] : []),
        ...(generation ? [encodeKeyPart(generation)] : []),
    ].join("/");
}

export async function prepareSQLiteAttachments(options: {
    ontology: string;
    uploads?: Array<{
        attachment: {
            id: string;
            type?: string;
        };
        blob: Blob;
    }>;
    storage?: SQLiteAttachmentStorageOptions;
}): Promise<SQLitePreparedAttachment[]> {
    const rows: SQLitePreparedAttachment[] = [];
    for (const { attachment, blob } of options.uploads ?? []) {
        const now = Date.now();
        const arrayBuffer = await blob.arrayBuffer();
        const digest = options.storage?.external
            ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", arrayBuffer)), (byte) =>
                  byte.toString(16).padStart(2, "0")
              ).join("")
            : undefined;
        const intentToken = options.storage?.external ? crypto.randomUUID() : null;
        const storageKey = options.storage?.external
            ? createSQLiteAttachmentStorageKey(
                  options.ontology,
                  attachment.id,
                  options.storage.external.keyPrefix,
                  digest,
                  intentToken ?? undefined
              )
            : null;
        const row: SQLitePreparedAttachment = {
            id: attachment.id,
            blob,
            bytes: storageKey ? null : new Uint8Array(arrayBuffer),
            storageKey,
            intentToken,
            type: blob.type || attachment.type || "application/octet-stream",
            name:
                typeof File !== "undefined" && blob instanceof File && blob.name.length > 0
                    ? blob.name
                    : null,
            size: blob.size,
            createdAt: now,
            updatedAt: now,
        };
        rows.push(row);
    }
    return rows;
}

export function persistSQLiteAttachmentRows(options: {
    database: SQLiteDatabase;
    ontology: string;
    rows: readonly SQLitePreparedAttachment[];
}): void {
    if (options.rows.length === 0) return;
    const upsert = options.database.prepare(`
        INSERT INTO party_stack_attachments (
            ontology, id, bytes, storage_key, type, name, size,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ontology, id) DO UPDATE SET
            bytes = excluded.bytes,
            storage_key = excluded.storage_key,
            type = excluded.type,
            name = excluded.name,
            size = excluded.size,
            updated_at = excluded.updated_at
    `);
    const existingAttachment = options.database.prepare(
        `SELECT storage_key
             FROM party_stack_attachments
             WHERE ontology = ? AND id = ?`
    );
    const journalReplaced = options.database.prepare(`
            INSERT INTO party_stack_attachment_orphans (
                storage_key, ontology, attachment_id, created_at,
                state, intent_token
            ) VALUES (?, ?, ?, ?, 'pending', ?)
            ON CONFLICT(storage_key) DO NOTHING
        `);
    const clearOrphan = options.database.prepare(
        `DELETE FROM party_stack_attachment_orphans
         WHERE storage_key = ? AND intent_token = ?`
    );
    for (const row of options.rows) {
        if (row.storageKey) {
            const orphan = options.database
                .prepare(
                    `SELECT state, intent_token
                     FROM party_stack_attachment_orphans
                     WHERE storage_key = ?`
                )
                .get(row.storageKey) as
                | {
                      state: string;
                      intent_token: string | null;
                  }
                | undefined;
            if (!orphan || orphan.state !== "pending" || orphan.intent_token !== row.intentToken) {
                throw new Error(`Attachment "${row.id}" is being garbage-collected; retry the action.`);
            }
        }
        const existing = existingAttachment.get(options.ontology, row.id) as
            | { storage_key: string | null }
            | undefined;
        if (existing?.storage_key && existing.storage_key !== row.storageKey) {
            journalReplaced.run(
                existing.storage_key,
                options.ontology,
                row.id,
                Date.now(),
                crypto.randomUUID()
            );
        }
        upsert.run(
            options.ontology,
            row.id,
            row.bytes,
            row.storageKey,
            row.type,
            row.name,
            row.size,
            row.createdAt,
            row.updatedAt
        );
        if (row.storageKey) {
            clearOrphan.run(row.storageKey, row.intentToken);
        }
    }
}

export function recordSQLiteAttachmentOrphans(options: {
    database: SQLiteDatabase;
    ontology: string;
    rows: readonly SQLitePreparedAttachment[];
}): void {
    if (options.rows.length === 0) return;
    const insert = options.database.prepare(`
        INSERT INTO party_stack_attachment_orphans (
            storage_key, ontology, attachment_id, created_at, state,
            intent_token
        ) VALUES (?, ?, ?, ?, 'uploading', ?)
        ON CONFLICT(storage_key) DO UPDATE SET
            created_at = excluded.created_at,
            state = 'uploading',
            intent_token = excluded.intent_token,
            claim_token = NULL,
            claimed_at = NULL
    `);
    for (const row of options.rows) {
        if (row.storageKey) {
            if (!row.intentToken) {
                throw new Error(`External attachment "${row.id}" is missing an upload intent token.`);
            }
            const existing = options.database
                .prepare(
                    `SELECT state
                     FROM party_stack_attachment_orphans
                     WHERE storage_key = ?`
                )
                .get(row.storageKey) as { state: string } | undefined;
            if (existing?.state === "collecting") {
                throw new Error(`Attachment "${row.id}" is being garbage-collected; retry the action.`);
            }
            insert.run(row.storageKey, options.ontology, row.id, Date.now(), row.intentToken);
        }
    }
}

export function markSQLiteAttachmentUploadsComplete(options: {
    database: SQLiteDatabase;
    rows: readonly SQLitePreparedAttachment[];
}): void {
    const update = options.database.prepare(`
        UPDATE party_stack_attachment_orphans
        SET state = 'pending'
        WHERE storage_key = ?
          AND intent_token = ?
          AND state = 'uploading'
    `);
    const read = options.database.prepare(`
        SELECT state, intent_token
        FROM party_stack_attachment_orphans
        WHERE storage_key = ?
    `);
    for (const row of options.rows) {
        if (!row.storageKey || !row.intentToken) continue;
        update.run(row.storageKey, row.intentToken);
        const current = read.get(row.storageKey) as
            | {
                  state: string;
                  intent_token: string | null;
              }
            | undefined;
        if (current?.state !== "pending" || current.intent_token !== row.intentToken) {
            throw new Error(
                `Attachment "${row.id}" upload intent changed before completion; retry the action.`
            );
        }
    }
}

export function getSQLiteAttachment(
    database: SQLiteDatabase,
    ontology: string,
    attachmentId: string
): SQLiteStoredAttachment | undefined {
    return database
        .prepare(
            `SELECT *
             FROM party_stack_attachments
             WHERE ontology = ? AND id = ?`
        )
        .get(ontology, attachmentId) as SQLiteStoredAttachment | undefined;
}

export async function readSQLiteAttachmentBlob(options: {
    row: SQLiteStoredAttachment;
    storage?: SQLiteAttachmentStorageOptions;
    inlineBlobPart(bytes: unknown): ArrayBuffer;
}): Promise<Blob> {
    if (options.row.storage_key) {
        const bytes = options.storage?.external?.bytes;
        if (!bytes) {
            throw new Error(`Attachment "${options.row.id}" requires external authoritative byte storage.`);
        }
        return bytes.read(options.row.storage_key);
    }
    return new Blob([options.inlineBlobPart(options.row.bytes)], {
        type: options.row.type,
    });
}

export async function collectSQLiteAttachmentOrphans(options: {
    database: SQLiteDatabase;
    bytes: SQLiteAttachmentBytesStore;
    ontology: string;
    olderThan?: number;
}): Promise<number> {
    const rows = options.database
        .prepare(
            `SELECT storage_key, ontology, created_at, intent_token
             FROM party_stack_attachment_orphans
             WHERE ontology = ? AND state = 'pending'`
        )
        .all(options.ontology) as Array<{
        storage_key: string;
        ontology: string;
        created_at: number;
        intent_token: string;
    }>;
    let deleted = 0;
    for (const row of rows) {
        if (options.olderThan !== undefined && row.created_at > options.olderThan) {
            continue;
        }
        let linked = false;
        let claimed = false;
        const claimToken = crypto.randomUUID();
        const claimedAt = Date.now();
        options.database.transaction(() => {
            linked =
                options.database
                    .prepare(
                        `SELECT 1
                         FROM party_stack_attachments
                         WHERE storage_key = ?
                         LIMIT 1`
                    )
                    .get(row.storage_key) !== undefined;
            if (linked) {
                options.database
                    .prepare(
                        `DELETE FROM party_stack_attachment_orphans
                         WHERE storage_key = ?`
                    )
                    .run(row.storage_key);
                return;
            }
            options.database
                .prepare(
                    `UPDATE party_stack_attachment_orphans
                     SET state = 'collecting',
                         claim_token = ?,
                         claimed_at = ?
                     WHERE storage_key = ?
                       AND state = 'pending'
                       AND intent_token = ?`
                )
                .run(claimToken, claimedAt, row.storage_key, row.intent_token);
            claimed =
                (
                    options.database
                        .prepare(
                            `SELECT state, claim_token
                             FROM party_stack_attachment_orphans
                             WHERE storage_key = ?`
                        )
                        .get(row.storage_key) as
                        | {
                              state: string;
                              claim_token: string | null;
                          }
                        | undefined
                )?.claim_token === claimToken;
        })();
        if (linked || !claimed) {
            continue;
        }
        try {
            await options.bytes.delete(row.storage_key);
        } catch (error) {
            options.database
                .prepare(
                    `UPDATE party_stack_attachment_orphans
                     SET state = 'pending',
                         claim_token = NULL,
                         claimed_at = NULL
                     WHERE storage_key = ? AND claim_token = ?`
                )
                .run(row.storage_key, claimToken);
            throw error;
        }
        deleted++;
        options.database
            .prepare(
                `DELETE FROM party_stack_attachment_orphans
                 WHERE storage_key = ? AND claim_token = ?`
            )
            .run(row.storage_key, claimToken);
    }
    return deleted;
}

/**
 * Recovers abandoned uploads and collector claims after an isolate/process
 * failure.
 *
 * Call during exclusive initialization (for example under
 * blockConcurrencyWhile), never while an orphan collector is still running.
 */
export function recoverSQLiteAttachmentOrphanClaims(options: {
    database: SQLiteDatabase;
    claimedBefore: number;
}): void {
    options.database.transaction(() => {
        options.database
            .prepare(
                `UPDATE party_stack_attachment_orphans
                 SET state = 'pending',
                     claim_token = NULL,
                     claimed_at = NULL
                 WHERE (
                    state = 'collecting' AND
                    (claimed_at IS NULL OR claimed_at <= ?)
                 ) OR (
                    state = 'uploading' AND created_at <= ?
                 )`
            )
            .run(options.claimedBefore, options.claimedBefore);
    })();
}
