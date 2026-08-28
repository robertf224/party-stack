import {
    applyLensToObject,
    applyLensToObjectType,
    createReadTx,
    runOptimisticAction,
} from "@party-stack/ontology";
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
    Lens,
    ObjectTypeDef,
    TypeDef,
} from "@party-stack/ontology";
import {
    ensureSQLiteAttachmentSchema,
    getSQLiteAttachment,
    prepareSQLiteAttachments,
    persistSQLiteAttachmentRows,
    readSQLiteAttachmentBlob,
    recordSQLiteAttachmentOrphans,
    type SQLiteAttachmentStorageOptions,
} from "./attachments.js";
import { runSQLiteOntologyMigrationsInTransaction, type SQLiteOntologyMigration } from "./migrations.js";
import { encodeLegacySQLiteIdentifierPart, resolveSQLiteNamespace } from "./namespace.js";
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

export interface CreateSQLiteOntologyBackendAdapterOptions {
    ir: OntologyIR;
    database: SQLiteDatabase;
    name?: string;
    sqlNamespace?: string;
    storageVersion?: number;
    migrations?: readonly SQLiteOntologyMigration[];
    attachmentStorage?: SQLiteAttachmentStorageOptions;
    lensBindings?: readonly SQLiteObjectTypeLensBinding[];
    mutators?: OntologyMutatorRegistry;
    queryFunctions?: OntologyQueryFunctionRegistry;
}

export interface SQLiteObjectTypeLensBinding {
    targetObjectType: string;
    sourceIR: OntologyIR;
    sourceObjectType: string;
    lens: Lens;
}

export class UnsupportedSQLiteLensWriteError extends Error {
    constructor(readonly objectType: string) {
        super(
            `SQLite lens-bound object type "${objectType}" is read-only because reverse lens writes are unsupported.`
        );
        this.name = "UnsupportedSQLiteLensWriteError";
    }
}

function getObjectType(opts: { ir: OntologyIR; objectTypeName: string }): ObjectTypeDef {
    const objectType = opts.ir.objectTypes.find((objectType) => objectType.name === opts.objectTypeName);
    if (!objectType) {
        throw new Error(`Unknown object type "${opts.objectTypeName}".`);
    }
    return objectType;
}

function sqlIdentifier(name: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Invalid SQLite identifier "${name}".`);
    }
    return `"${name}"`;
}

function getObjectTableName(opts: { sqlNamespace: string; objectTypeName: string }): string {
    return `party_stack_${opts.sqlNamespace}_${encodeLegacySQLiteIdentifierPart(opts.objectTypeName)}`;
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

function resolveTypeForSignature(ir: OntologyIR, type: TypeDef, resolving = new Set<string>()): unknown {
    if (type.kind === "ref") {
        const name = type.value.name;
        if (resolving.has(name)) {
            return {
                kind: "recursive-ref",
                name,
            };
        }
        const named = ir.types.find((candidate) => candidate.name === name);
        if (!named) {
            throw new Error(`Unknown type reference "${name}".`);
        }
        const next = new Set(resolving);
        next.add(name);
        return {
            kind: "resolved-ref",
            name,
            type: resolveTypeForSignature(ir, named.type, next),
        };
    }
    switch (type.kind) {
        case "list":
            return {
                ...type,
                value: {
                    ...type.value,
                    elementType: resolveTypeForSignature(ir, type.value.elementType, resolving),
                },
            };
        case "map":
            return {
                ...type,
                value: {
                    ...type.value,
                    keyType: resolveTypeForSignature(ir, type.value.keyType, resolving),
                    valueType: resolveTypeForSignature(ir, type.value.valueType, resolving),
                },
            };
        case "struct":
            return {
                ...type,
                value: {
                    ...type.value,
                    fields: type.value.fields.map((field) => ({
                        ...field,
                        type: resolveTypeForSignature(ir, field.type, resolving),
                    })),
                },
            };
        case "union":
            return {
                ...type,
                value: {
                    ...type.value,
                    variants: type.value.variants.map((variant) => ({
                        ...variant,
                        type: resolveTypeForSignature(ir, variant.type, resolving),
                    })),
                },
            };
        case "optional":
            return {
                ...type,
                value: {
                    ...type.value,
                    type: resolveTypeForSignature(ir, type.value.type, resolving),
                },
            };
        case "result":
            return {
                ...type,
                value: {
                    ...type.value,
                    okType: resolveTypeForSignature(ir, type.value.okType, resolving),
                    errType: resolveTypeForSignature(ir, type.value.errType, resolving),
                },
            };
        default:
            return type;
    }
}

function getResolvedObjectTypeSchemaSignature(ir: OntologyIR, objectType: ObjectTypeDef): string {
    return JSON.stringify({
        primaryKey: objectType.primaryKey,
        properties: objectType.properties.map((property) => ({
            name: property.name,
            type: resolveTypeForSignature(ir, property.type),
        })),
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

function ensureObjectTable(opts: {
    database: SQLiteDatabase;
    adapterName: string;
    sqlNamespace: string;
    objectType: ObjectTypeDef;
    allowSchemaUpgrade: boolean;
    skipSchemaSignature?: boolean;
}): void {
    const { database, adapterName, sqlNamespace, objectType } = opts;
    const tableName = getObjectTableName({
        sqlNamespace,
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
    if (opts.skipSchemaSignature) {
        return;
    }

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
    if (existing && existing.value !== signature && !opts.allowSchemaUpgrade) {
        throw new Error(
            `SQLite ontology schema for object type "${objectType.name}" does not match the current ontology.`
        );
    }
    if (!existing) {
        database
            .prepare(`INSERT INTO ${sqlIdentifier("party_stack_schema")} (key, value) VALUES (?, ?)`)
            .run(schemaKey, signature);
    } else if (existing.value !== signature) {
        database
            .prepare(
                `UPDATE ${sqlIdentifier("party_stack_schema")}
                 SET value = ?
                 WHERE key = ?`
            )
            .run(signature, schemaKey);
    }
}

function ensureSchema(opts: {
    database: SQLiteDatabase;
    adapterName: string;
    sqlNamespace?: string;
    ir: OntologyIR;
    storageVersion?: number;
    migrations?: readonly SQLiteOntologyMigration[];
    legacyAttachmentSqlNamespace?: string;
    lensBindings?: readonly SQLiteObjectTypeLensBinding[];
}): string {
    ensureMetadataTable(opts.database);
    const sqlNamespace = resolveSQLiteNamespace({
        database: opts.database,
        adapterName: opts.adapterName,
        sqlNamespace: opts.sqlNamespace,
    });
    ensureSQLiteAttachmentSchema({
        database: opts.database,
        legacyAttachmentSqlNamespace: opts.legacyAttachmentSqlNamespace,
    });
    const bindings = new Map((opts.lensBindings ?? []).map((binding) => [binding.targetObjectType, binding]));
    if (bindings.size !== (opts.lensBindings ?? []).length) {
        throw new Error("SQLite lens bindings must have unique target object types.");
    }
    for (const binding of bindings.values()) {
        if (!opts.ir.objectTypes.some((objectType) => objectType.name === binding.targetObjectType)) {
            throw new Error(`SQLite lens binding targets unknown object type "${binding.targetObjectType}".`);
        }
    }
    const storageObjectTypes = opts.ir.objectTypes.map((objectType) => {
        const binding = bindings.get(objectType.name);
        const storageObjectType = binding
            ? getObjectType({
                  ir: binding.sourceIR,
                  objectTypeName: binding.sourceObjectType,
              })
            : objectType;
        return {
            objectType,
            binding,
            storageObjectType,
        };
    });
    // Historical migrations may access their object tables. Bootstrap the
    // current physical shape first, without accepting or updating signatures.
    for (const { storageObjectType } of storageObjectTypes) {
        ensureObjectTable({
            database: opts.database,
            adapterName: opts.adapterName,
            sqlNamespace,
            objectType: storageObjectType,
            allowSchemaUpgrade: false,
            skipSchemaSignature: true,
        });
    }
    const migration = runSQLiteOntologyMigrationsInTransaction({
        database: opts.database,
        adapterName: opts.adapterName,
        sqlNamespace,
        ir: opts.ir,
        migrations: opts.migrations,
        storageVersion: opts.storageVersion,
        objectTableName: (objectTypeName) =>
            getObjectTableName({
                sqlNamespace,
                objectTypeName,
            }),
    });
    for (const { objectType, binding, storageObjectType } of storageObjectTypes) {
        if (binding) {
            const projected = applyLensToObjectType(storageObjectType, binding.lens, {
                name: objectType.name,
                displayName: objectType.displayName,
                pluralDisplayName: objectType.pluralDisplayName,
            });
            if (
                getResolvedObjectTypeSchemaSignature(binding.sourceIR, projected) !==
                getResolvedObjectTypeSchemaSignature(opts.ir, objectType)
            ) {
                throw new Error(
                    `SQLite lens binding for "${objectType.name}" does not project to the configured target schema.`
                );
            }
        }
        ensureObjectTable({
            database: opts.database,
            adapterName: opts.adapterName,
            sqlNamespace,
            objectType: storageObjectType,
            allowSchemaUpgrade: migration.appliedVersions.length > 0,
        });
    }
    return sqlNamespace;
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
    sqlNamespace: string;
    ir: OntologyIR;
    objectTypeName: string;
    mutations: Array<PendingMutation<OntologyObject>>;
    lensBinding?: SQLiteObjectTypeLensBinding;
}): void {
    if (opts.mutations.length === 0) return;
    if (opts.lensBinding) {
        throw new UnsupportedSQLiteLensWriteError(opts.objectTypeName);
    }

    const objectType = getObjectType({
        ir: opts.ir,
        objectTypeName: opts.objectTypeName,
    });
    const tableName = getObjectTableName({
        sqlNamespace: opts.sqlNamespace,
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
    sqlNamespace: string;
    ir: OntologyIR;
    objectTypeName: string;
    lensBinding?: SQLiteObjectTypeLensBinding;
}): OntologyCollectionOptions {
    const objectType = getObjectType({
        ir: opts.ir,
        objectTypeName: opts.objectTypeName,
    });
    const storageIR = opts.lensBinding?.sourceIR ?? opts.ir;
    const storageObjectType = opts.lensBinding
        ? getObjectType({
              ir: storageIR,
              objectTypeName: opts.lensBinding.sourceObjectType,
          })
        : objectType;
    const tableName = getObjectTableName({
        sqlNamespace: opts.sqlNamespace,
        objectTypeName: storageObjectType.name,
    });

    const sync: SyncConfig<OntologyObject, string | number> = {
        sync: ({ begin, collection, commit, markError, markReady, write }) => {
            const load = () => {
                const rows = opts.database
                    .prepare(
                        `SELECT ${sqlIdentifier(storageObjectType.primaryKey)} AS id, data FROM ${sqlIdentifier(tableName)}`
                    )
                    .all() as ObjectRow[];
                const persistedKeys = new Set<string | number>();
                const currentKeys = new Set<string | number>(collection.keys());

                begin();
                for (const row of rows) {
                    const parsedObject = JSON.parse(row.data) as OntologyObject;
                    const hydratedObject = decode({
                        ir: storageIR,
                        target: {
                            kind: "object",
                            name: storageObjectType.name,
                        },
                        value: parsedObject,
                    }) as OntologyObject;
                    const projectedObject = opts.lensBinding
                        ? applyLensToObject<OntologyObject, OntologyObject>(
                              hydratedObject,
                              opts.lensBinding.lens
                          )
                        : hydratedObject;
                    const key = projectedObject[objectType.primaryKey] as string | number;
                    persistedKeys.add(key);
                    write({
                        type: currentKeys.has(key) ? "update" : "insert",
                        value: projectedObject,
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
    sqlNamespace: string,
    storage?: SQLiteAttachmentStorageOptions
): OntologyAttachmentsAdapter {
    const getAttachmentRow = (id: string) => getSQLiteAttachment(database, sqlNamespace, id);

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
    const lensBindings = new Map(
        (opts.lensBindings ?? []).map((binding) => [binding.targetObjectType, binding])
    );
    let sqlNamespace = "";
    opts.database.transaction(() => {
        sqlNamespace = ensureSchema({
            database: opts.database,
            adapterName,
            sqlNamespace: opts.sqlNamespace,
            ir: opts.ir,
            storageVersion: opts.storageVersion,
            migrations: opts.migrations,
            lensBindings: opts.lensBindings,
            legacyAttachmentSqlNamespace: opts.attachmentStorage?.legacyAttachmentSqlNamespace,
        });
    })();

    return {
        name: adapterName,
        getCollectionOptions: (objectTypeName) =>
            createCollectionOptions({
                database: opts.database,
                sqlNamespace,
                ir: opts.ir,
                objectTypeName,
                lensBinding: lensBindings.get(objectTypeName),
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
                        ontology: sqlNamespace,
                        uploads: live.attachmentUploads,
                        storage: opts.attachmentStorage,
                    });
                    const externalRows = prepared.filter((row) => row.storageKey !== null);
                    if (externalRows.length > 0) {
                        // Journal intent before the external write. A crash or
                        // any later failure therefore leaves a discoverable,
                        // safely collectable key.
                        opts.database.transaction(() =>
                            recordSQLiteAttachmentOrphans({
                                database: opts.database,
                                ontology: sqlNamespace,
                                rows: externalRows,
                            })
                        )();
                        const bytes = opts.attachmentStorage?.external?.bytes;
                        if (!bytes) {
                            throw new Error("External SQLite attachment rows require a byte store.");
                        }
                        for (const row of externalRows) {
                            await bytes.write(row.storageKey!, row.blob);
                        }
                    }
                    opts.database.transaction(() => {
                        for (const [objectTypeName, collection] of Object.entries(collections)) {
                            persistObjectMutations({
                                database: opts.database,
                                sqlNamespace,
                                ir: opts.ir,
                                objectTypeName,
                                lensBinding: lensBindings.get(objectTypeName),
                                mutations: collectCollectionMutations({
                                    transaction,
                                    collection,
                                }),
                            });
                        }
                        persistSQLiteAttachmentRows({
                            database: opts.database,
                            ontology: sqlNamespace,
                            rows: prepared,
                        });
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
        attachments: createAttachmentsAdapter(opts.database, sqlNamespace, opts.attachmentStorage),
    };
}

export type CreateSQLiteOntologyBackendOptions<
    Context extends Record<string, unknown> = Record<string, unknown>,
> = {
    name?: string;
    sqlNamespace?: string;
    storageVersion?: number;
    migrations?: readonly SQLiteOntologyMigration[];
    attachmentStorage?: SQLiteAttachmentStorageOptions;
    lensBindings?: readonly SQLiteObjectTypeLensBinding[];
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
            sqlNamespace: opts.sqlNamespace,
            storageVersion: opts.storageVersion,
            migrations: opts.migrations,
            attachmentStorage: opts.attachmentStorage,
            lensBindings: opts.lensBindings,
            mutators: opts.mutators,
            queryFunctions: opts.queryFunctions,
        });
}

export {
    createSQLiteBackendInstallation,
    createSQLiteOntologyRoute,
    type CreateSQLiteBackendInstallationOptions,
    type CreateSQLiteOntologyRouteOptions,
    type SQLiteOntologyRoute,
} from "./installation.js";
export type { SQLiteDatabase, SQLiteDatabaseProvider, SQLiteStatement } from "./database.js";
export {
    collectSQLiteAttachmentOrphans,
    createSQLiteAttachmentStorageKey,
    LegacySQLiteAttachmentMigrationRequiredError,
    recoverSQLiteAttachmentOrphanClaims,
    SQLiteAttachmentNotFoundError,
    type SQLiteAttachmentStorageOptions,
    type SQLiteExternalAttachmentStorage,
} from "./attachments.js";
export {
    getSQLiteMigrationVersion,
    runSQLiteOntologyMigrations,
    type SQLiteMigrationResult,
    type SQLiteOntologyMigration,
    type SQLiteOntologyMigrationContext,
} from "./migrations.js";
export {
    encodeLegacySQLiteIdentifierPart,
    encodeSQLiteNamespace,
    SQLiteNamespaceCollisionError,
} from "./namespace.js";
