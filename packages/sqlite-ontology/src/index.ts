import { applyActionLogic } from "@party-stack/ontology";
import { decode, encode } from "@party-stack/ontology/json";
import { resolveType } from "@party-stack/ontology/utils";
import { createTransaction, eq, queryOnce } from "@tanstack/db";
import type {
    OntologyAdapter,
    OntologyAttachmentsAdapter,
    OntologyCollectionOptions,
    OntologyIR,
    ObjectTypeDef,
} from "@party-stack/ontology";
import type { attachment } from "@party-stack/ontology/values";
import type { Collection, PendingMutation, SyncConfig } from "@tanstack/db";

type OntologyRecord = Record<string, unknown>;
type BetterSqlite3Database = {
    exec: (sql: string) => void;
    prepare: (sql: string) => {
        all: (...params: unknown[]) => unknown[];
        get: (...params: unknown[]) => unknown;
        run: (...params: unknown[]) => unknown;
    };
    transaction: (fn: () => void) => () => void;
};
type OntologyCollection = Collection<OntologyRecord>;

interface AttachmentRow {
    id: string;
    bytes: Buffer;
    type: string;
    name: string | null;
    size: number;
    createdAt: number;
    updatedAt: number;
}

interface ObjectRow {
    id: string | number;
    data: string;
}

interface SchemaRow {
    value: string;
}

export interface CreateSQLiteOntologyAdapterOptions {
    ir: OntologyIR;
    database: BetterSqlite3Database;
    name?: string;
}

function getObjectType(opts: { ir: OntologyIR; objectTypeName: string }): ObjectTypeDef {
    const objectType = opts.ir.objectTypes.find((objectType) => objectType.name === opts.objectTypeName);
    if (!objectType) {
        throw new Error(`Unknown object type "${opts.objectTypeName}".`);
    }
    return objectType;
}

function encodeIdentifierPart(value: string): string {
    const encoded = value.replace(/[^A-Za-z0-9_]/g, (character) =>
        `_x${character.codePointAt(0)!.toString(16)}_`
    );
    return /^[A-Za-z_]/.test(encoded) ? encoded : `_${encoded}`;
}

function sqlIdentifier(name: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Invalid SQLite identifier "${name}".`);
    }
    return `"${name}"`;
}

function getObjectTableName(opts: {
    adapterName: string;
    objectTypeName: string;
}): string {
    return `party_stack_${encodeIdentifierPart(opts.adapterName)}_${encodeIdentifierPart(opts.objectTypeName)}`;
}

function getObjectTypeSchemaSignature(objectType: ObjectTypeDef): string {
    return JSON.stringify({
        version: 1,
        objectType: {
            name: objectType.name,
            primaryKey: objectType.primaryKey,
            properties: objectType.properties.map((property) => ({
                name: property.name,
                type: property.type,
            })),
        },
    });
}

function ensureMetadataTable(database: BetterSqlite3Database): void {
    database.exec(`
        CREATE TABLE IF NOT EXISTS ${sqlIdentifier("party_stack_schema")} (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `);
}

function ensureAttachmentsTable(database: BetterSqlite3Database): void {
    database.exec(`
        CREATE TABLE IF NOT EXISTS ${sqlIdentifier("party_stack_attachments")} (
            id TEXT PRIMARY KEY,
            bytes BLOB NOT NULL,
            type TEXT NOT NULL,
            name TEXT,
            size INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
    `);
}

function ensureObjectTable(opts: {
    database: BetterSqlite3Database;
    adapterName: string;
    objectType: ObjectTypeDef;
}): void {
    const { database, adapterName, objectType } = opts;
    const tableName = getObjectTableName({
        adapterName,
        objectTypeName: objectType.name,
    });
    if (objectType.primaryKey === "data") {
        throw new Error(`Object type "${objectType.name}" cannot use "data" as its primary key.`);
    }

    database.exec(`
        CREATE TABLE IF NOT EXISTS ${sqlIdentifier(tableName)} (
            ${sqlIdentifier(objectType.primaryKey)} TEXT PRIMARY KEY,
            data TEXT NOT NULL
        );
    `);

    const columns = database.prepare(`PRAGMA table_info(${sqlIdentifier(tableName)})`).all() as Array<{
        name: string;
        type: string;
        pk: number;
        notnull: number;
    }>;
    const primaryKeyColumn = columns.find((column) => column.name === objectType.primaryKey);
    const dataColumn = columns.find((column) => column.name === "data");
    if (!primaryKeyColumn || primaryKeyColumn.pk === 0) {
        throw new Error(
            `SQLite ontology table "${tableName}" does not have expected primary key "${objectType.primaryKey}".`
        );
    }
    if (!dataColumn || dataColumn.type.toUpperCase() !== "TEXT" || dataColumn.notnull === 0) {
        throw new Error(`SQLite ontology table "${tableName}" does not have expected data TEXT column.`);
    }

    const schemaKey = `object:${adapterName}:${objectType.name}`;
    const signature = getObjectTypeSchemaSignature(objectType);
    const existing = database
        .prepare(`SELECT value FROM ${sqlIdentifier("party_stack_schema")} WHERE key = ?`)
        .get(schemaKey) as SchemaRow | undefined;
    if (existing && existing.value !== signature) {
        throw new Error(
            `SQLite ontology schema for object type "${objectType.name}" does not match the current ontology.`
        );
    }
    if (!existing) {
        database
            .prepare(
                `INSERT INTO ${sqlIdentifier("party_stack_schema")} (key, value) VALUES (?, ?)`
            )
            .run(schemaKey, signature);
    }
}

function ensureSchema(opts: {
    database: BetterSqlite3Database;
    adapterName: string;
    ir: OntologyIR;
}): void {
    ensureMetadataTable(opts.database);
    ensureAttachmentsTable(opts.database);
    for (const objectType of opts.ir.objectTypes) {
        ensureObjectTable({
            database: opts.database,
            adapterName: opts.adapterName,
            objectType,
        });
    }
}

async function loadActionReferenceObjects(opts: {
    ir: OntologyIR;
    actionTypeName: string;
    parameters: Record<string, unknown>;
    collections: Record<string, OntologyCollection>;
}): Promise<void> {
    const actionType = opts.ir.actionTypes.find((actionType) => actionType.name === opts.actionTypeName);
    if (!actionType) return;

    for (const step of actionType.logic) {
        if (step.kind !== "updateObject" && step.kind !== "deleteObject") continue;

        const parameterName = step.value.object.path[0];
        if (!parameterName) continue;

        const parameter = actionType.parameters.find((candidate) => candidate.name === parameterName);
        if (!parameter) continue;

        const type = resolveType(opts.ir, parameter.type);
        if (type.kind !== "objectReference") continue;

        const primaryKey = opts.parameters[parameterName];
        if (typeof primaryKey !== "string" && typeof primaryKey !== "number") continue;

        const objectType = opts.ir.objectTypes.find((candidate) => candidate.name === type.value.objectType);
        const collection = opts.collections[type.value.objectType];
        if (!objectType || !collection || collection.get(primaryKey)) continue;

        await queryOnce((q) =>
            q
                .from({ object: collection })
                .where(({ object }) =>
                    eq((object as Record<string, unknown>)[objectType.primaryKey], primaryKey)
                )
                .select(({ object }) => object)
        );
    }
}

function collectCollectionMutations(opts: {
    transaction: { mutations: Array<PendingMutation<OntologyRecord>> },
    collection: Collection<OntologyRecord>;
}): Array<PendingMutation<OntologyRecord>> {
    return opts.transaction.mutations.filter((mutation) => mutation.collection === opts.collection);
}

function getMutationObject(mutation: PendingMutation<OntologyRecord>): OntologyRecord | undefined {
    const candidate = mutation as PendingMutation<OntologyRecord> & {
        modified?: OntologyRecord;
        original?: OntologyRecord;
        changes?: OntologyRecord;
    };
    return candidate.modified ?? candidate.original ?? candidate.changes;
}

function getMutationType(mutation: PendingMutation<OntologyRecord>): "insert" | "update" | "delete" {
    const type = (mutation as PendingMutation<OntologyRecord> & { type?: unknown }).type;
    if (type === "insert" || type === "update" || type === "delete") return type;
    throw new Error("Unknown TanStack DB mutation type.");
}

function getPrimaryKeyValue(opts: {
    objectTypeName: string;
    primaryKey: string;
    object: OntologyRecord | undefined;
}): string | number {
    const primaryKeyValue = opts.object?.[opts.primaryKey];
    if (typeof primaryKeyValue !== "string" && typeof primaryKeyValue !== "number") {
        throw new Error(
            `Mutation for object type "${opts.objectTypeName}" did not include primary key "${opts.primaryKey}".`
        );
    }
    return primaryKeyValue;
}

function persistObjectMutations(opts: {
    database: BetterSqlite3Database;
    adapterName: string;
    ir: OntologyIR;
    objectTypeName: string;
    mutations: Array<PendingMutation<OntologyRecord>>;
}): void {
    if (opts.mutations.length === 0) return;

    const objectType = getObjectType({
        ir: opts.ir,
        objectTypeName: opts.objectTypeName,
    });
    const tableName = getObjectTableName({
        adapterName: opts.adapterName,
        objectTypeName: opts.objectTypeName,
    });
    const primaryKeyColumn = sqlIdentifier(objectType.primaryKey);
    const table = sqlIdentifier(tableName);
    const upsert = opts.database.prepare(`
        INSERT INTO ${table} (${primaryKeyColumn}, data)
        VALUES (?, ?)
        ON CONFLICT(${primaryKeyColumn}) DO UPDATE SET
            data = excluded.data
    `);
    const remove = opts.database.prepare(`DELETE FROM ${table} WHERE ${primaryKeyColumn} = ?`);

    for (const mutation of opts.mutations) {
        const mutationType = getMutationType(mutation);
        const object = getMutationObject(mutation);
        const primaryKeyValue = getPrimaryKeyValue({
            objectTypeName: opts.objectTypeName,
            primaryKey: objectType.primaryKey,
            object,
        });

        if (mutationType === "delete") {
            remove.run(String(primaryKeyValue));
            continue;
        }

        const serializedObject = encode({
            ir: opts.ir,
            target: { kind: "object", name: opts.objectTypeName },
            value: object!,
        }) as OntologyRecord;
        upsert.run(String(primaryKeyValue), JSON.stringify(serializedObject));
    }
}

async function prepareAttachmentRows(
    uploads: Array<{ attachment: attachment; blob: Blob }> = []
): Promise<AttachmentRow[]> {
    return Promise.all(
        uploads.map(async ({ attachment: attachmentValue, blob }) => {
            const now = Date.now();
            return {
                id: attachmentValue.id,
                bytes: Buffer.from(await blob.arrayBuffer()),
                type: blob.type || attachmentValue.type || "application/octet-stream",
                name:
                    typeof File !== "undefined" && blob instanceof File && blob.name.length > 0
                        ? blob.name
                        : attachmentValue.name ?? null,
                size: blob.size,
                createdAt: now,
                updatedAt: now,
            };
        })
    );
}

function persistAttachmentRows(database: BetterSqlite3Database, rows: AttachmentRow[]): void {
    if (rows.length === 0) return;

    const upsert = database.prepare(`
        INSERT INTO ${sqlIdentifier("party_stack_attachments")} (
            id,
            bytes,
            type,
            name,
            size,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            bytes = excluded.bytes,
            type = excluded.type,
            name = excluded.name,
            size = excluded.size,
            updated_at = excluded.updated_at
    `);

    for (const row of rows) {
        upsert.run(row.id, row.bytes, row.type, row.name, row.size, row.createdAt, row.updatedAt);
    }
}

function createCollectionOptions(opts: {
    database: BetterSqlite3Database;
    adapterName: string;
    ir: OntologyIR;
    objectTypeName: string;
}): OntologyCollectionOptions {
    const objectType = getObjectType({
        ir: opts.ir,
        objectTypeName: opts.objectTypeName,
    });
    const tableName = getObjectTableName({
        adapterName: opts.adapterName,
        objectTypeName: opts.objectTypeName,
    });

    const sync: SyncConfig<OntologyRecord, string | number> = {
        sync: ({ begin, collection, commit, markReady, write }) => {
            const load = () => {
                const rows = opts.database
                    .prepare(
                        `SELECT ${sqlIdentifier(objectType.primaryKey)} AS id, data FROM ${sqlIdentifier(tableName)}`
                    )
                    .all() as ObjectRow[];
                const persistedKeys = new Set<string | number>();
                const currentKeys = new Set<string | number>(collection.keys());

                begin();
                for (const row of rows) {
                    const parsedObject = JSON.parse(row.data) as OntologyRecord;
                    const hydratedObject = decode({
                        ir: opts.ir,
                        target: { kind: "object", name: opts.objectTypeName },
                        value: parsedObject,
                    }) as OntologyRecord;
                    const key = hydratedObject[objectType.primaryKey] as string | number;
                    persistedKeys.add(key);
                    write({
                        type: currentKeys.has(key) ? "update" : "insert",
                        value: hydratedObject,
                    });
                }

                for (const key of currentKeys) {
                    if (!persistedKeys.has(key)) {
                        write({ type: "delete", key });
                    }
                }
                commit();
            };

            load();
            markReady();

            return {
                loadSubset: () => {
                    load();
                    return true;
                },
                cleanup: () => {},
            };
        },
    };

    return {
        syncMode: "on-demand",
        startSync: true,
        sync,
    };
}

function createAttachmentsAdapter(database: BetterSqlite3Database): OntologyAttachmentsAdapter {
    const getAttachmentRow = (id: string) =>
        database
            .prepare(`SELECT * FROM ${sqlIdentifier("party_stack_attachments")} WHERE id = ?`)
            .get(id) as
            | {
                  id: string;
                  bytes: Buffer;
                  type: string;
                  name: string | null;
                  size: number;
                  created_at: number;
                  updated_at: number;
              }
            | undefined;

    return {
        generateAttachmentId: () => crypto.randomUUID(),
        getAttachmentContent: (attachmentValue) => {
            const row = getAttachmentRow(attachmentValue.id);
            if (!row) {
                throw new Error(`Attachment "${attachmentValue.id}" not found.`);
            }
            return Promise.resolve(
                new Blob([row.bytes], {
                    type: row.type,
                })
            );
        },
        getAttachmentMetadata: (
            attachmentValue
        ): Promise<attachment & { size: number; type: string; name: string }> => {
            const row = getAttachmentRow(attachmentValue.id);
            if (!row) {
                throw new Error(`Attachment "${attachmentValue.id}" not found.`);
            }
            return Promise.resolve({
                ...attachmentValue,
                size: row.size,
                type: row.type,
                name: row.name ?? attachmentValue.name ?? attachmentValue.id,
            });
        },
    };
}

export function createSQLiteOntologyAdapter(opts: CreateSQLiteOntologyAdapterOptions): OntologyAdapter {
    const adapterName = opts.name ?? "sqlite";
    ensureSchema({
        database: opts.database,
        adapterName,
        ir: opts.ir,
    });

    return {
        name: adapterName,
        getCollectionOptions: (objectTypeName) =>
            createCollectionOptions({
                database: opts.database,
                adapterName,
                ir: opts.ir,
                objectTypeName,
            }),
        applyAction: async (actionTypeName, parameters, live) => {
            const collections = live.objects as Record<string, OntologyCollection>;
            await loadActionReferenceObjects({
                ir: opts.ir,
                actionTypeName,
                parameters,
                collections,
            });

            const transaction = createTransaction<OntologyRecord>({
                mutationFn: async ({ transaction }) => {
                    const attachmentRows = await prepareAttachmentRows(live.attachmentUploads);
                    const persistTransaction = opts.database.transaction(() => {
                        for (const [objectTypeName, collection] of Object.entries(collections)) {
                            persistObjectMutations({
                                database: opts.database,
                                adapterName,
                                ir: opts.ir,
                                objectTypeName,
                                mutations: collectCollectionMutations({
                                    transaction,
                                    collection,
                                }),
                            });
                        }
                        persistAttachmentRows(opts.database, attachmentRows);
                    });
                    persistTransaction();
                },
            });

            transaction.mutate(() => {
                applyActionLogic({
                    ir: opts.ir,
                    actionTypeName,
                    parameters,
                    context: live.context ?? {},
                    objects: collections,
                });
            });

            await transaction.isPersisted.promise;
        },
        runQuery: (name) =>
            Promise.reject(new Error(`SQLite ontology adapter cannot run query type "${name}".`)),
        attachments: createAttachmentsAdapter(opts.database),
    };
}
