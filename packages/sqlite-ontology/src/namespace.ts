import type { SQLiteDatabase } from "./database.js";

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class SQLiteNamespaceCollisionError extends Error {
    constructor(
        readonly sqlNamespace: string,
        readonly adapterNames: readonly string[]
    ) {
        super(
            `SQLite SQL namespace "${sqlNamespace}" is claimed by multiple ontology adapters: ${adapterNames
                .map((name) => `"${name}"`)
                .join(", ")}.`
        );
        this.name = "SQLiteNamespaceCollisionError";
    }
}

export function encodeLegacySQLiteIdentifierPart(value: string): string {
    const encoded = value.replace(
        /[^A-Za-z0-9_]/g,
        (character) => `_x${character.codePointAt(0)!.toString(16)}_`
    );
    return /^[A-Za-z_]/.test(encoded) ? encoded : `_${encoded}`;
}

export function encodeSQLiteNamespace(value: string): string {
    let hex = "";
    for (let index = 0; index < value.length; index++) {
        hex += value.charCodeAt(index).toString(16).padStart(4, "0");
    }
    return `ontology_v2_${hex}`;
}

export function resolveRequestedSQLiteNamespace(options: {
    adapterName: string;
    sqlNamespace?: string;
}): string {
    if (options.sqlNamespace !== undefined) {
        return SAFE_IDENTIFIER.test(options.sqlNamespace)
            ? options.sqlNamespace
            : encodeLegacySQLiteIdentifierPart(options.sqlNamespace);
    }
    return encodeLegacySQLiteIdentifierPart(options.adapterName);
}

function hasLegacySchema(database: SQLiteDatabase, adapterName: string): boolean {
    const prefix = `object:${adapterName}:`;
    return database
        .prepare("SELECT key FROM party_stack_schema")
        .all()
        .some(
            (row) =>
                typeof row === "object" &&
                row !== null &&
                "key" in row &&
                typeof row.key === "string" &&
                row.key.startsWith(prefix)
        );
}

export function ensureSQLiteNamespaceRegistry(database: SQLiteDatabase): void {
    database.exec(`
        CREATE TABLE IF NOT EXISTS party_stack_namespaces (
            sql_namespace TEXT PRIMARY KEY,
            adapter_name TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL
        )
    `);
}

export function resolveSQLiteNamespace(options: {
    database: SQLiteDatabase;
    adapterName: string;
    sqlNamespace?: string;
}): string {
    ensureSQLiteNamespaceRegistry(options.database);

    const existingForAdapter = options.database
        .prepare(
            `SELECT sql_namespace
             FROM party_stack_namespaces
             WHERE adapter_name = ?`
        )
        .get(options.adapterName) as { sql_namespace: string } | undefined;
    const requested = resolveRequestedSQLiteNamespace(options);
    if (existingForAdapter) {
        if (options.sqlNamespace !== undefined && existingForAdapter.sql_namespace !== requested) {
            throw new Error(
                `SQLite ontology adapter "${options.adapterName}" is already pinned to SQL namespace ` +
                    `"${existingForAdapter.sql_namespace}", not "${requested}".`
            );
        }
        return existingForAdapter.sql_namespace;
    }

    const legacyNamespace = encodeLegacySQLiteIdentifierPart(options.adapterName);
    const requestedIsAutomatic = options.sqlNamespace === encodeSQLiteNamespace(options.adapterName);
    const resolved =
        (options.sqlNamespace === undefined || requestedIsAutomatic) &&
        hasLegacySchema(options.database, options.adapterName)
            ? legacyNamespace
            : requested;
    if (resolved === "__party_stack_attachments__") {
        throw new Error(`SQLite SQL namespace "${resolved}" is reserved for Party Stack internals.`);
    }
    const existingForNamespace = options.database
        .prepare(
            `SELECT adapter_name
             FROM party_stack_namespaces
             WHERE sql_namespace = ? COLLATE NOCASE`
        )
        .get(resolved) as { adapter_name: string } | undefined;
    if (existingForNamespace && existingForNamespace.adapter_name !== options.adapterName) {
        throw new SQLiteNamespaceCollisionError(resolved, [
            existingForNamespace.adapter_name,
            options.adapterName,
        ]);
    }
    options.database
        .prepare(
            `INSERT INTO party_stack_namespaces (
                sql_namespace, adapter_name, created_at
             ) VALUES (?, ?, ?)`
        )
        .run(resolved, options.adapterName, Date.now());
    return resolved;
}
