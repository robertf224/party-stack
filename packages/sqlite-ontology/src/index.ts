import { type SQLiteAttachmentStorageOptions } from "./attachments.js";
import { makeSQLiteOntologyBackend } from "./backend.js";
import type { SQLiteDatabase } from "./database.js";
import type {
    OntologyBackendAdapter,
    OntologyBackendAdapterProvider,
    OntologyIR,
    OntologyMutatorRegistry,
    OntologyQueryFunctionRegistry,
} from "@party-stack/ontology";
export interface CreateSQLiteOntologyBackendAdapterOptions {
    ir: OntologyIR;
    database: SQLiteDatabase;
    name?: string;
    attachmentStorage?: SQLiteAttachmentStorageOptions;
    mutators?: OntologyMutatorRegistry;
    queryFunctions?: OntologyQueryFunctionRegistry;
}
export function createSQLiteOntologyBackendAdapter(
    opts: CreateSQLiteOntologyBackendAdapterOptions
): OntologyBackendAdapter {
    return {
        name: opts.name ?? "sqlite",
        open: (context) => makeSQLiteOntologyBackend({ ...opts, context }),
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
export * from "./backend.js";
