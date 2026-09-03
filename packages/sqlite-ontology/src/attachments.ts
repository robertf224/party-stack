import type { SQLiteDatabase } from "./database.js";

const ATTACHMENT_MIGRATION_NAMESPACE =
    "__party_stack_attachments__";
const ATTACHMENT_SCHEMA_VERSION = 1;

function ensureInternalMigrationTable(
    database: SQLiteDatabase
): void {
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

function getAttachmentMigrationVersion(
    database: SQLiteDatabase
): number {
    ensureInternalMigrationTable(database);
    const row = database
        .prepare(
            `SELECT COALESCE(MAX(version), 0) AS version
             FROM party_stack_migrations
             WHERE namespace = ?`
        )
        .get(ATTACHMENT_MIGRATION_NAMESPACE) as
        | { version?: number }
        | undefined;
    return Number(row?.version ?? 0);
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
    bytes: unknown;
    storage_key: string | null;
    type: string;
    name: string | null;
    size: number;
    created_at: number;
    updated_at: number;
}

interface AttachmentColumn {
    name: string;
    notnull: number;
    pk: number;
}

function createAttachmentTable(
    database: SQLiteDatabase,
    table = "party_stack_attachments"
): void {
    database.exec(`
        CREATE TABLE "${table}" (
            id TEXT PRIMARY KEY,
            bytes BLOB,
            storage_key TEXT,
            type TEXT NOT NULL,
            name TEXT,
            size INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            CHECK (
                (bytes IS NOT NULL AND storage_key IS NULL) OR
                (bytes IS NULL AND storage_key IS NOT NULL)
            )
        )
    `);
}

function tableExists(
    database: SQLiteDatabase,
    table: string
): boolean {
    return (
        database
            .prepare(
                `SELECT name FROM sqlite_master
                 WHERE type = 'table' AND name = ?`
            )
            .get(table) !== undefined
    );
}

function attachmentColumns(
    database: SQLiteDatabase
): AttachmentColumn[] {
    return database
        .prepare(
            `PRAGMA table_info("party_stack_attachments")`
        )
        .all() as AttachmentColumn[];
}

function isCurrentSchema(
    columns: readonly AttachmentColumn[]
): boolean {
    const id = columns.find(
        (column) => column.name === "id"
    );
    const bytes = columns.find(
        (column) => column.name === "bytes"
    );
    return (
        id?.pk === 1 &&
        bytes?.notnull === 0 &&
        columns.some(
            (column) =>
                column.name === "storage_key"
        ) &&
        !columns.some(
            (column) => column.name === "ontology"
        )
    );
}

function migrateAttachmentTable(
    database: SQLiteDatabase
): void {
    if (
        !tableExists(
            database,
            "party_stack_attachments"
        )
    ) {
        createAttachmentTable(database);
        return;
    }
    const columns = attachmentColumns(database);
    if (isCurrentSchema(columns)) return;

    const hasOntology = columns.some(
        (column) => column.name === "ontology"
    );
    const hasStorageKey = columns.some(
        (column) => column.name === "storage_key"
    );
    if (hasOntology) {
        const ontologyCount = database
            .prepare(
                `SELECT COUNT(DISTINCT ontology) AS count
                 FROM party_stack_attachments`
            )
            .get() as { count: number };
        if (Number(ontologyCount.count) > 1) {
            throw new Error(
                "Cannot collapse a multi-ontology attachment table into one ontology database."
            );
        }
        const duplicate = database
            .prepare(
                `SELECT id
                 FROM party_stack_attachments
                 GROUP BY id
                 HAVING COUNT(*) > 1
                 LIMIT 1`
            )
            .get();
        if (duplicate) {
            throw new Error(
                "Cannot collapse a multi-ontology attachment table containing duplicate IDs into one ontology database."
            );
        }
    }

    database.exec(
        `DROP TABLE IF EXISTS "party_stack_attachments__migrating"`
    );
    createAttachmentTable(
        database,
        "party_stack_attachments__migrating"
    );
    const count = database
        .prepare(
            `SELECT COUNT(*) AS count
             FROM party_stack_attachments`
        )
        .get() as { count: number };
    const insert = database.prepare(`
        INSERT INTO "party_stack_attachments__migrating" (
            id, bytes, storage_key, type, name, size,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let lastId: string | null = null;
    for (
        let copied = 0;
        copied < Number(count.count);
        copied++
    ) {
        const row = database
            .prepare(
                `SELECT *
                 FROM party_stack_attachments
                 WHERE (? IS NULL OR id > ?)
                 ORDER BY id
                 LIMIT 1`
            )
            .get(lastId, lastId) as
            | Record<string, unknown>
            | undefined;
        if (!row) {
            throw new Error(
                "Attachment migration could not advance its keyset cursor."
            );
        }
        insert.run(
            row.id,
            row.bytes ?? null,
            hasStorageKey
                ? (row.storage_key ?? null)
                : null,
            row.type,
            row.name ?? null,
            row.size,
            row.created_at,
            row.updated_at
        );
        lastId = String(row.id);
    }
    database.exec(`
        DROP TABLE "party_stack_attachments";
        ALTER TABLE "party_stack_attachments__migrating"
        RENAME TO "party_stack_attachments"
    `);
}

function createAttachmentOrphanTable(
    database: SQLiteDatabase,
    table = "party_stack_attachment_orphans"
): void {
    database.exec(`
        CREATE TABLE "${table}" (
            storage_key TEXT PRIMARY KEY,
            attachment_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            state TEXT NOT NULL DEFAULT 'pending',
            intent_token TEXT,
            claim_token TEXT,
            claimed_at INTEGER
        )
    `);
}

function ensureAttachmentOrphanTable(
    database: SQLiteDatabase
): void {
    if (
        !tableExists(
            database,
            "party_stack_attachment_orphans"
        )
    ) {
        createAttachmentOrphanTable(database);
        return;
    }
    const columns = database
        .prepare(
            `PRAGMA table_info("party_stack_attachment_orphans")`
        )
        .all() as AttachmentColumn[];
    if (
        columns.some(
            (column) => column.name === "ontology"
        )
    ) {
        const names = new Set(
            columns.map((column) => column.name)
        );
        database.exec(
            `DROP TABLE IF EXISTS "party_stack_attachment_orphans__migrating"`
        );
        createAttachmentOrphanTable(
            database,
            "party_stack_attachment_orphans__migrating"
        );
        database.exec(`
            INSERT INTO "party_stack_attachment_orphans__migrating" (
                storage_key, attachment_id, created_at, state,
                intent_token, claim_token, claimed_at
            )
            SELECT
                storage_key,
                attachment_id,
                created_at,
                ${names.has("state") ? "state" : "'pending'"},
                ${names.has("intent_token") ? "intent_token" : "NULL"},
                ${names.has("claim_token") ? "claim_token" : "NULL"},
                ${names.has("claimed_at") ? "claimed_at" : "NULL"}
            FROM party_stack_attachment_orphans;
            DROP TABLE "party_stack_attachment_orphans";
            ALTER TABLE "party_stack_attachment_orphans__migrating"
            RENAME TO "party_stack_attachment_orphans"
        `);
        return;
    }
    const names = new Set(
        columns.map((column) => column.name)
    );
    if (!names.has("state")) {
        database.exec(`
            ALTER TABLE party_stack_attachment_orphans
            ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'
        `);
    }
    if (!names.has("intent_token")) {
        database.exec(`
            ALTER TABLE party_stack_attachment_orphans
            ADD COLUMN intent_token TEXT
        `);
    }
    if (!names.has("claim_token")) {
        database.exec(`
            ALTER TABLE party_stack_attachment_orphans
            ADD COLUMN claim_token TEXT
        `);
    }
    if (!names.has("claimed_at")) {
        database.exec(`
            ALTER TABLE party_stack_attachment_orphans
            ADD COLUMN claimed_at INTEGER
        `);
    }
}

export function ensureSQLiteAttachmentSchema(
    database: SQLiteDatabase
): void {
    ensureInternalMigrationTable(database);
    const version =
        getAttachmentMigrationVersion(database);
    if (version > ATTACHMENT_SCHEMA_VERSION) {
        throw new Error(
            `SQLite attachment schema version ${version} is newer than supported version ${ATTACHMENT_SCHEMA_VERSION}.`
        );
    }
    if (
        version < ATTACHMENT_SCHEMA_VERSION ||
        !tableExists(
            database,
            "party_stack_attachments"
        )
    ) {
        migrateAttachmentTable(database);
        database
            .prepare(
                `INSERT INTO party_stack_migrations (
                    namespace, version, name, applied_at
                 ) VALUES (?, ?, ?, ?)
                 ON CONFLICT(namespace, version) DO NOTHING`
            )
            .run(
                ATTACHMENT_MIGRATION_NAMESPACE,
                ATTACHMENT_SCHEMA_VERSION,
                "single-ontology-external-storage",
                Date.now()
            );
    } else if (
        !isCurrentSchema(
            attachmentColumns(database)
        )
    ) {
        throw new Error(
            "SQLite attachment migration ledger does not match its table schema."
        );
    }
    ensureAttachmentOrphanTable(database);
    database.exec(`
        UPDATE party_stack_attachment_orphans
        SET intent_token = lower(hex(randomblob(16)))
        WHERE intent_token IS NULL
    `);
}

function encodeKeyPart(value: string): string {
    let encoded = "";
    for (let index = 0; index < value.length; index++) {
        encoded += value
            .charCodeAt(index)
            .toString(16)
            .padStart(4, "0");
    }
    return encoded;
}

export function createSQLiteAttachmentStorageKey(
    attachmentId: string,
    prefix = "party-stack/attachments",
    contentDigest?: string,
    generation?: string
): string {
    return [
        prefix,
        encodeKeyPart(attachmentId),
        ...(contentDigest ? [contentDigest] : []),
        ...(generation
            ? [encodeKeyPart(generation)]
            : []),
    ].join("/");
}

export async function prepareSQLiteAttachments(options: {
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
    for (const { attachment, blob } of
        options.uploads ?? []) {
        const arrayBuffer = await blob.arrayBuffer();
        const digest = options.storage?.external
            ? Array.from(
                  new Uint8Array(
                      await crypto.subtle.digest(
                          "SHA-256",
                          arrayBuffer
                      )
                  ),
                  (byte) =>
                      byte
                          .toString(16)
                          .padStart(2, "0")
              ).join("")
            : undefined;
        const intentToken =
            options.storage?.external
                ? crypto.randomUUID()
                : null;
        const storageKey = options.storage?.external
            ? createSQLiteAttachmentStorageKey(
                  attachment.id,
                  options.storage.external.keyPrefix,
                  digest,
                  intentToken ?? undefined
              )
            : null;
        const now = Date.now();
        rows.push({
            id: attachment.id,
            blob,
            bytes: storageKey
                ? null
                : new Uint8Array(arrayBuffer),
            storageKey,
            intentToken,
            type:
                blob.type ||
                attachment.type ||
                "application/octet-stream",
            name:
                typeof File !== "undefined" &&
                blob instanceof File &&
                blob.name.length > 0
                    ? blob.name
                    : null,
            size: blob.size,
            createdAt: now,
            updatedAt: now,
        });
    }
    return rows;
}

export function recordSQLiteAttachmentUploads(
    database: SQLiteDatabase,
    rows: readonly SQLitePreparedAttachment[]
): void {
    const insert = database.prepare(`
        INSERT INTO party_stack_attachment_orphans (
            storage_key, attachment_id, created_at, state,
            intent_token
        ) VALUES (?, ?, ?, 'uploading', ?)
        ON CONFLICT(storage_key) DO UPDATE SET
            created_at = excluded.created_at,
            state = 'uploading',
            intent_token = excluded.intent_token,
            claim_token = NULL,
            claimed_at = NULL
    `);
    for (const row of rows) {
        if (!row.storageKey || !row.intentToken) continue;
        insert.run(
            row.storageKey,
            row.id,
            Date.now(),
            row.intentToken
        );
    }
}

export function markSQLiteAttachmentUploadsComplete(
    database: SQLiteDatabase,
    rows: readonly SQLitePreparedAttachment[]
): void {
    const update = database.prepare(`
        UPDATE party_stack_attachment_orphans
        SET state = 'pending'
        WHERE storage_key = ?
          AND intent_token = ?
          AND state = 'uploading'
    `);
    const read = database.prepare(`
        SELECT state, intent_token
        FROM party_stack_attachment_orphans
        WHERE storage_key = ?
    `);
    for (const row of rows) {
        if (!row.storageKey || !row.intentToken) continue;
        update.run(row.storageKey, row.intentToken);
        const completed = read.get(row.storageKey) as
            | {
                  state: string;
                  intent_token: string | null;
              }
            | undefined;
        if (
            completed?.state !== "pending" ||
            completed.intent_token !== row.intentToken
        ) {
            throw new Error(
                `Attachment "${row.id}" upload intent was replaced before completion.`
            );
        }
    }
}

export function persistSQLiteAttachmentRows(
    database: SQLiteDatabase,
    rows: readonly SQLitePreparedAttachment[]
): void {
    const previous = database.prepare(
        `SELECT storage_key
         FROM party_stack_attachments
         WHERE id = ?`
    );
    const orphanPrevious = database.prepare(`
        INSERT INTO party_stack_attachment_orphans (
            storage_key, attachment_id, created_at, state,
            intent_token
        ) VALUES (?, ?, ?, 'pending', ?)
        ON CONFLICT(storage_key) DO NOTHING
    `);
    const upsert = database.prepare(`
        INSERT INTO party_stack_attachments (
            id, bytes, storage_key, type, name, size,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            bytes = excluded.bytes,
            storage_key = excluded.storage_key,
            type = excluded.type,
            name = excluded.name,
            size = excluded.size,
            updated_at = excluded.updated_at
    `);
    const clearIntent = database.prepare(
        `DELETE FROM party_stack_attachment_orphans
         WHERE storage_key = ? AND intent_token = ?`
    );
    for (const row of rows) {
        if (row.storageKey) {
            const intent = database
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
            if (
                intent?.state !== "pending" ||
                intent.intent_token !==
                    row.intentToken
            ) {
                throw new Error(
                    `Attachment "${row.id}" upload is not ready to commit.`
                );
            }
        }
        const existing = previous.get(row.id) as
            | { storage_key: string | null }
            | undefined;
        if (
            existing?.storage_key &&
            existing.storage_key !== row.storageKey
        ) {
            orphanPrevious.run(
                existing.storage_key,
                row.id,
                Date.now(),
                crypto.randomUUID()
            );
        }
        upsert.run(
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
            clearIntent.run(
                row.storageKey,
                row.intentToken
            );
        }
    }
}

export function getSQLiteAttachment(
    database: SQLiteDatabase,
    attachmentId: string
): SQLiteStoredAttachment | undefined {
    return database
        .prepare(
            `SELECT * FROM party_stack_attachments
             WHERE id = ?`
        )
        .get(attachmentId) as
        | SQLiteStoredAttachment
        | undefined;
}

export async function readSQLiteAttachmentBlob(options: {
    row: SQLiteStoredAttachment;
    storage?: SQLiteAttachmentStorageOptions;
    inlineBlobPart(bytes: unknown): ArrayBuffer;
}): Promise<Blob> {
    if (options.row.storage_key) {
        const store = options.storage?.external?.bytes;
        if (!store) {
            throw new Error(
                `Attachment "${options.row.id}" requires external byte storage.`
            );
        }
        return store.read(options.row.storage_key);
    }
    return new Blob(
        [options.inlineBlobPart(options.row.bytes)],
        { type: options.row.type }
    );
}

export async function collectSQLiteAttachmentOrphans(options: {
    database: SQLiteDatabase;
    bytes: SQLiteAttachmentBytesStore;
    olderThan?: number;
}): Promise<number> {
    const rows = options.database
        .prepare(
            `SELECT storage_key, created_at, intent_token
             FROM party_stack_attachment_orphans
             WHERE state = 'pending'`
        )
        .all() as Array<{
        storage_key: string;
        created_at: number;
        intent_token: string;
    }>;
    let deleted = 0;
    for (const row of rows) {
        if (
            options.olderThan !== undefined &&
            row.created_at > options.olderThan
        ) {
            continue;
        }
        const claimToken = crypto.randomUUID();
        let linked = false;
        let claimed = false;
        options.database.transaction(() => {
            linked =
                options.database
                    .prepare(
                        `SELECT 1 FROM party_stack_attachments
                         WHERE storage_key = ? LIMIT 1`
                    )
                    .get(row.storage_key) !==
                undefined;
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
                .run(
                    claimToken,
                    Date.now(),
                    row.storage_key,
                    row.intent_token
                );
            claimed =
                (
                    options.database
                        .prepare(
                            `SELECT claim_token
                             FROM party_stack_attachment_orphans
                             WHERE storage_key = ?`
                        )
                        .get(row.storage_key) as
                        | {
                              claim_token: string | null;
                          }
                        | undefined
                )?.claim_token === claimToken;
        })();
        if (linked || !claimed) continue;
        try {
            await options.bytes.delete(
                row.storage_key
            );
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
        options.database
            .prepare(
                `DELETE FROM party_stack_attachment_orphans
                 WHERE storage_key = ? AND claim_token = ?`
            )
            .run(row.storage_key, claimToken);
        deleted++;
    }
    return deleted;
}

export function recoverSQLiteAttachmentOrphanClaims(options: {
    database: SQLiteDatabase;
    abandonedBefore: number;
}): void {
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
        .run(
            options.abandonedBefore,
            options.abandonedBefore
        );
}
