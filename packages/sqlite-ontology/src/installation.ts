import {
    createOntologyBackendInstallation,
    type ConfigureOntologyOptions,
    type LiveOntologyWrites,
    type OntologyBackendInstallation,
    type OntologyIR,
    type OntologyMutatorRegistry,
    type OntologyQueryFunctionRegistry,
    type OntologyRoute,
} from "@party-stack/ontology";
import type { BackendConnectionAdapterProvider } from "@party-stack/connections";
import type { RuntimeAdapterProvider } from "@party-stack/runtime";
import { encodeSQLiteNamespace } from "./namespace.js";
import { createSQLiteOntologyBackend, type SQLiteObjectTypeLensBinding } from "./index.js";
import type { SQLiteAttachmentStorageOptions } from "./attachments.js";
import type { SQLiteDatabase, SQLiteDatabaseProvider } from "./database.js";
import type { SQLiteOntologyMigration } from "./migrations.js";

export type SQLiteOntologyRoute = (database: SQLiteDatabaseProvider) => OntologyRoute;

export interface CreateSQLiteOntologyRouteOptions {
    ontologyId: string;
    ir: OntologyIR;
    name?: string;
    sqlNamespace?: string;
    storageVersion?: number;
    migrations?: readonly SQLiteOntologyMigration[];
    attachmentStorage?: SQLiteAttachmentStorageOptions;
    lensBindings?: readonly SQLiteObjectTypeLensBinding[];
    mutators?: OntologyMutatorRegistry;
    queryFunctions?: OntologyQueryFunctionRegistry;
    context?: Record<string, unknown> | ((options: ConfigureOntologyOptions) => Record<string, unknown>);
    persistObjects?: boolean;
    writes?: LiveOntologyWrites;
}

/**
 * Defines one logical ontology stored in an owned SQLite database.
 *
 * The ontology ID is also the default SQL namespace. This lets multiple
 * logical ontologies safely share one physical SQLite database.
 */
export function createSQLiteOntologyRoute(options: CreateSQLiteOntologyRouteOptions): SQLiteOntologyRoute {
    return (database) => ({
        matches: (ontologyId) => ontologyId === options.ontologyId,
        async configure(configureOptions) {
            const ontologyId = configureOptions.ontologyId;
            const resolvedDatabase = await database(ontologyId);
            const adapterName = options.name ?? ontologyId;
            return {
                ir: options.ir,
                backend: createSQLiteOntologyBackend({
                    database: resolvedDatabase,
                    name: adapterName,
                    sqlNamespace:
                        options.sqlNamespace ??
                        (options.name === undefined ? encodeSQLiteNamespace(ontologyId) : undefined),
                    storageVersion: options.storageVersion,
                    migrations: options.migrations,
                    attachmentStorage: options.attachmentStorage,
                    lensBindings: options.lensBindings,
                    mutators: options.mutators,
                    queryFunctions: options.queryFunctions,
                }),
                context:
                    typeof options.context === "function"
                        ? options.context(configureOptions)
                        : options.context,
                persistObjects: options.persistObjects,
                writes: options.writes,
            };
        },
    });
}

export interface CreateSQLiteBackendInstallationOptions<AuthenticationClient extends object = object> {
    installationId: string;
    database: SQLiteDatabase | SQLiteDatabaseProvider;
    connections: BackendConnectionAdapterProvider<AuthenticationClient>;
    runtime: RuntimeAdapterProvider;
    routes: readonly SQLiteOntologyRoute[];
    createContext?: (userId: string, ontologyId: string) => Record<string, unknown>;
}

/**
 * Creates an authenticated installation over tenant-owned SQLite storage.
 *
 * Database resolution receives only the logical ontology ID. Authentication
 * and connection/session state remain installation concerns and cannot
 * accidentally change the owned storage partition.
 */
export function createSQLiteBackendInstallation<AuthenticationClient extends object = object>(
    options: CreateSQLiteBackendInstallationOptions<AuthenticationClient>
): Promise<OntologyBackendInstallation<AuthenticationClient>> {
    const databaseOption = options.database;
    const database: SQLiteDatabaseProvider =
        typeof databaseOption === "function" ? databaseOption : () => databaseOption;
    return createOntologyBackendInstallation({
        installationId: options.installationId,
        connections: options.connections,
        runtime: options.runtime,
        routes: options.routes.map((route) => route(database)),
        createContext: options.createContext,
    });
}
