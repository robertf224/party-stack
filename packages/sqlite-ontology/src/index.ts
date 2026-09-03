import { createReadTx, runOptimisticAction } from "@party-stack/ontology";
import { decode, encode } from "@party-stack/ontology/json";
import { resolveType } from "@party-stack/ontology/utils";
import { createTransaction, eq, queryOnce } from "@tanstack/db";
import type {
    AttachmentMetadata,
    OntologyBackendAdapter,
    OntologyBackendAdapterProvider,
    OntologyAttachmentsAdapter,
    OntologyCollectionOptions,
    OntologyIR,
    OntologyMutatorRegistry,
    OntologyObject,
    OntologyQueryFunctionRegistry,
    ObjectTypeDef,
} from "@party-stack/ontology";
import {
    ensureSQLiteAttachmentSchema,
    getSQLiteAttachment,
    markSQLiteAttachmentUploadsComplete,
    prepareSQLiteAttachments,
    persistSQLiteAttachmentRows,
    readSQLiteAttachmentBlob,
    recordSQLiteAttachmentUploads,
    type SQLiteAttachmentStorageOptions,
} from "./attachments.js";
import type { SQLiteDatabase } from "./database.js";
import type { Collection, PendingMutation, SyncConfig } from "@tanstack/db";

type OntologyCollection = Collection<OntologyObject>;

interface ObjectRow {
    id: string | number;
    data: string;
}

interface SchemaRow {
    value: string;
}

const DATABASE_ONTOLOGY_KEY =
    "__party_stack_ontology__";

export interface CreateSQLiteOntologyBackendAdapterOptions {
    ir: OntologyIR;
    database: SQLiteDatabase;
    name?: string;
    attachmentStorage?: SQLiteAttachmentStorageOptions;
    mutators?: OntologyMutatorRegistry;
    queryFunctions?: OntologyQueryFunctionRegistry;
}

function getObjectType(opts: { ir: OntologyIR; objectTypeName: string }): ObjectTypeDef {
    const objectType = opts.ir.objectTypes.find((objectType) => objectType.name === opts.objectTypeName);
    if (!objectType) {
        throw new Error(`Unknown object type "${opts.objectTypeName}".`);
    }
    return objectType;
}

function encodeIdentifierPart(value: string): string {
    const encoded = value.replace(
        /[^A-Za-z0-9_]/g,
        (character) =>
            `_x${character.codePointAt(0)!.toString(16)}_`
    );
    return /^[A-Za-z_]/.test(encoded)
        ? encoded
        : `_${encoded}`;
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

function ensureMetadataTable(database: SQLiteDatabase): void {
    database.exec(`
        CREATE TABLE IF NOT EXISTS ${sqlIdentifier("party_stack_schema")} (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `);
}

function ensureDatabaseOntology(
    database: SQLiteDatabase,
    adapterName: string
): void {
    const existing = database
        .prepare(
            `SELECT value FROM ${sqlIdentifier("party_stack_schema")}
             WHERE key = ?`
        )
        .get(DATABASE_ONTOLOGY_KEY) as
        | SchemaRow
        | undefined;
    if (existing && existing.value !== adapterName) {
        throw new Error(
            `SQLite database already belongs to ontology "${existing.value}"; create a separate database for "${adapterName}".`
        );
    }
    if (!existing) {
        database
            .prepare(
                `INSERT INTO ${sqlIdentifier("party_stack_schema")}
                 (key, value) VALUES (?, ?)`
            )
            .run(DATABASE_ONTOLOGY_KEY, adapterName);
    }
}

function ensureObjectTable(opts: {
    database: SQLiteDatabase;
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
            .prepare(`INSERT INTO ${sqlIdentifier("party_stack_schema")} (key, value) VALUES (?, ?)`)
            .run(schemaKey, signature);
    }
}

function ensureSchema(opts: {
    database: SQLiteDatabase;
    adapterName: string;
    ir: OntologyIR;
}): void {
    ensureMetadataTable(opts.database);
    ensureDatabaseOntology(
        opts.database,
        opts.adapterName
    );
    ensureSQLiteAttachmentSchema(opts.database);
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
    transaction: { mutations: Array<PendingMutation<OntologyObject>> };
    collection: Collection<OntologyObject>;
}): Array<PendingMutation<OntologyObject>> {
    return opts.transaction.mutations.filter((mutation) => mutation.collection === opts.collection);
}

function getMutationObject(mutation: PendingMutation<OntologyObject>): OntologyObject | undefined {
    const candidate = mutation as PendingMutation<OntologyObject> & {
        modified?: OntologyObject;
        original?: OntologyObject;
        changes?: OntologyObject;
    };
    return candidate.modified ?? candidate.original ?? candidate.changes;
}

function getMutationType(mutation: PendingMutation<OntologyObject>): "insert" | "update" | "delete" {
    const type = (mutation as PendingMutation<OntologyObject> & { type?: unknown }).type;
    if (type === "insert" || type === "update" || type === "delete") return type;
    throw new Error("Unknown TanStack DB mutation type.");
}

function getPrimaryKeyValue(opts: {
    objectTypeName: string;
    primaryKey: string;
    object: OntologyObject | undefined;
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
    database: SQLiteDatabase;
    adapterName: string;
    ir: OntologyIR;
    objectTypeName: string;
    mutations: Array<PendingMutation<OntologyObject>>;
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
        }) as OntologyObject;
        upsert.run(String(primaryKeyValue), JSON.stringify(serializedObject));
    }
}

function createCollectionOptions(opts: {
    database: SQLiteDatabase;
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
        objectTypeName: objectType.name,
    });

    const sync: SyncConfig<OntologyObject, string | number> = {
        sync: ({ begin, collection, commit, markError, markReady, write }) => {
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
                    const parsedObject = JSON.parse(row.data) as OntologyObject;
                    const hydratedObject = decode({
                        ir: opts.ir,
                        target: { kind: "object", name: opts.objectTypeName },
                        value: parsedObject,
                    }) as OntologyObject;
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
                return commit();
            };

            const initialLoad = load();
            if (initialLoad === true) {
                markReady();
            } else {
                void initialLoad.then(markReady, markError);
            }

            return {
                loadSubset: load,
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

function toAttachmentBlobPart(bytes: unknown): ArrayBuffer {
    if (bytes instanceof ArrayBuffer) {
        return bytes;
    }
    if (ArrayBuffer.isView(bytes)) {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    throw new Error("SQLite attachment bytes are not a BLOB.");
}

function createAttachmentsAdapter(
    database: SQLiteDatabase,
    storage?: SQLiteAttachmentStorageOptions
): OntologyAttachmentsAdapter {
    const getAttachmentRow = (id: string) => getSQLiteAttachment(database, id);

    return {
        generateAttachmentId: () => crypto.randomUUID(),
        getAttachmentContent: async (attachmentValue) => {
            const row = getAttachmentRow(attachmentValue.id);
            if (!row) {
                throw new Error(`Attachment "${attachmentValue.id}" not found.`);
            }
            return readSQLiteAttachmentBlob({
                row,
                storage,
                inlineBlobPart: toAttachmentBlobPart,
            });
        },
        getAttachmentMetadata: (attachmentValue): Promise<AttachmentMetadata & { name: string }> => {
            const row = getAttachmentRow(attachmentValue.id);
            if (!row) {
                throw new Error(`Attachment "${attachmentValue.id}" not found.`);
            }
            return Promise.resolve({
                ...attachmentValue,
                size: row.size,
                type: row.type,
                name: row.name ?? attachmentValue.id,
            });
        },
    };
}

export function createSQLiteOntologyBackendAdapter(
    opts: CreateSQLiteOntologyBackendAdapterOptions
): OntologyBackendAdapter {
    const adapterName = opts.name ?? "sqlite";
    opts.database.transaction(() => {
        ensureSchema({
            database: opts.database,
            adapterName,
            ir: opts.ir,
        });
    })();

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
            const actionType = opts.ir.actionTypes.find((candidate) => candidate.name === actionTypeName);
            if (!actionType) {
                throw new Error(`Unknown action type "${actionTypeName}".`);
            }
            if (actionType.logic.length === 0 && !opts.mutators?.[actionTypeName]) {
                throw new Error(
                    `SQLite ontology adapter cannot apply non-declarative action type "${actionTypeName}" without a registered mutator.`
                );
            }
            const collections = live.objects as Record<string, OntologyCollection>;
            await loadActionReferenceObjects({
                ir: opts.ir,
                actionTypeName,
                parameters,
                collections,
            });

            const transaction = createTransaction<OntologyObject>({
                autoCommit: false,
                mutationFn: async ({ transaction }) => {
                    const prepared = await prepareSQLiteAttachments({
                        uploads: live.attachmentUploads,
                        storage: opts.attachmentStorage,
                    });
                    const externalRows = prepared.filter((row) => row.storageKey !== null);
                    if (externalRows.length > 0) {
                        // Journal intent before the external write. A crash or
                        // any later failure therefore leaves a discoverable,
                        // safely collectable key.
                        opts.database.transaction(() =>
                            recordSQLiteAttachmentUploads(
                                opts.database,
                                externalRows
                            )
                        )();
                        const bytes = opts.attachmentStorage?.external?.bytes;
                        if (!bytes) {
                            throw new Error("External SQLite attachment rows require a byte store.");
                        }
                        for (const row of externalRows) {
                            await bytes.write(row.storageKey!, row.blob);
                        }
                        // No await occurs between publishing completion and
                        // the final metadata/object transaction, so a
                        // collector cannot interleave once this becomes
                        // collectable.
                        opts.database.transaction(() =>
                            markSQLiteAttachmentUploadsComplete(
                                opts.database,
                                externalRows
                            )
                        )();
                    }
                    opts.database.transaction(() => {
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
                        persistSQLiteAttachmentRows(
                            opts.database,
                            prepared
                        );
                    })();
                },
            });

            await runOptimisticAction({
                transaction,
                ir: opts.ir,
                actionTypeName,
                parameters,
                context: live.context ?? {},
                objects: collections,
                mutators: opts.mutators,
            });
            await transaction.commit();
        },
        runQueryFunction: async (name, parameters, live) => {
            const handler = opts.queryFunctions?.[name];
            if (!handler) {
                throw new Error(
                    `SQLite ontology adapter cannot run query function type "${name}" without a registered handler.`
                );
            }
            return await handler({
                tx: createReadTx(live.objects as Record<string, OntologyCollection>),
                args: parameters,
                context: live.context ?? {},
            });
        },
        attachments: createAttachmentsAdapter(opts.database, opts.attachmentStorage),
    };
}

export type CreateSQLiteOntologyBackendOptions<
    Context extends Record<string, unknown> = Record<string, unknown>,
> = {
    name?: string;
    attachmentStorage?: SQLiteAttachmentStorageOptions;
    mutators?: OntologyMutatorRegistry;
    queryFunctions?: OntologyQueryFunctionRegistry;
} & (
    | {
          database: SQLiteDatabase;
      }
    | {
          createDatabase: (ir: OntologyIR, context: Context) => SQLiteDatabase | Promise<SQLiteDatabase>;
      }
);

export function createSQLiteOntologyBackend<
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: CreateSQLiteOntologyBackendOptions<Context>): OntologyBackendAdapterProvider<Context> {
    return async (ir, context) =>
        createSQLiteOntologyBackendAdapter({
            ir,
            database: "database" in opts ? opts.database : await opts.createDatabase(ir, context),
            name: opts.name,
            attachmentStorage: opts.attachmentStorage,
            mutators: opts.mutators,
            queryFunctions: opts.queryFunctions,
        });
}

export type { SQLiteDatabase, SQLiteDatabaseProvider, SQLiteStatement } from "./database.js";
export {
    collectSQLiteAttachmentOrphans,
    createSQLiteAttachmentStorageKey,
    recoverSQLiteAttachmentOrphanClaims,
    type SQLiteAttachmentBytesStore,
    type SQLiteAttachmentStorageOptions,
    type SQLiteExternalAttachmentStorage,
} from "./attachments.js";
