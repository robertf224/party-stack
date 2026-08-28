import type { OntologyIR } from "@party-stack/ontology";
import type { SQLiteDatabase } from "./database.js";

export interface SQLiteOntologyMigrationContext {
    database: SQLiteDatabase;
    adapterName: string;
    sqlNamespace: string;
    ir: OntologyIR;
    objectTableName(objectTypeName: string): string;
}

export interface SQLiteOntologyMigration {
    version: number;
    name?: string;
    up: (context: SQLiteOntologyMigrationContext) => void;
}

export interface SQLiteMigrationResult {
    fromVersion: number;
    toVersion: number;
    appliedVersions: readonly number[];
}

export function ensureSQLiteMigrationTable(database: SQLiteDatabase): void {
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

export function getSQLiteMigrationVersion(database: SQLiteDatabase, namespace: string): number {
    ensureSQLiteMigrationTable(database);
    const row = database
        .prepare(
            `SELECT COALESCE(MAX(version), 0) AS version
             FROM party_stack_migrations
             WHERE namespace = ?`
        )
        .get(namespace) as { version?: number } | undefined;
    return Number(row?.version ?? 0);
}

function createGuardedMigrationDatabase(database: SQLiteDatabase, isActive: () => boolean): SQLiteDatabase {
    const assertActive = () => {
        if (!isActive()) {
            throw new Error("SQLite migration attempted to use its database after returning.");
        }
    };
    return {
        exec(sql) {
            assertActive();
            return database.exec(sql);
        },
        prepare(sql) {
            assertActive();
            const statement = database.prepare(sql);
            return {
                all(...parameters) {
                    assertActive();
                    return statement.all(...parameters);
                },
                get(...parameters) {
                    assertActive();
                    return statement.get(...parameters);
                },
                run(...parameters) {
                    assertActive();
                    return statement.run(...parameters);
                },
            };
        },
        transaction(callback) {
            assertActive();
            if (callback.constructor.name === "AsyncFunction") {
                throw new Error("SQLite migration transaction callbacks must be synchronous.");
            }
            return () => {
                assertActive();
                database.transaction(() => {
                    assertActive();
                    const returned = (callback as () => unknown)();
                    if (returned && typeof returned === "object" && "then" in returned) {
                        void Promise.resolve(returned).catch(() => undefined);
                        throw new Error("SQLite migration transaction callbacks must be synchronous.");
                    }
                    assertActive();
                })();
            };
        },
    };
}

export function runSQLiteOntologyMigrationsInTransaction(options: {
    database: SQLiteDatabase;
    adapterName: string;
    sqlNamespace: string;
    ir: OntologyIR;
    migrations?: readonly SQLiteOntologyMigration[];
    storageVersion?: number;
    objectTableName(objectTypeName: string): string;
}): SQLiteMigrationResult {
    ensureSQLiteMigrationTable(options.database);
    const migrations = [...(options.migrations ?? [])].sort((left, right) => left.version - right.version);
    const byVersion = new Map<number, SQLiteOntologyMigration>();
    for (const migration of migrations) {
        if (!Number.isSafeInteger(migration.version) || migration.version <= 0) {
            throw new Error(
                `SQLite migration versions must be positive integers; received ${migration.version}.`
            );
        }
        if (byVersion.has(migration.version)) {
            throw new Error(
                `SQLite migration version ${migration.version} is registered more than once for "${options.adapterName}".`
            );
        }
        if (migration.up.constructor.name === "AsyncFunction") {
            throw new Error(
                `SQLite migration version ${migration.version} for "${options.adapterName}" is async; migrations must be synchronous.`
            );
        }
        byVersion.set(migration.version, migration);
    }

    const fromVersion = getSQLiteMigrationVersion(options.database, options.sqlNamespace);
    const toVersion = options.storageVersion ?? migrations.at(-1)?.version ?? 0;
    if (!Number.isSafeInteger(toVersion) || toVersion < 0) {
        throw new Error(`SQLite storageVersion must be a non-negative integer; received ${toVersion}.`);
    }
    if (fromVersion > toVersion) {
        throw new Error(
            `SQLite namespace "${options.sqlNamespace}" is at storage version ${fromVersion}, ` +
                `which is newer than requested version ${toVersion}.`
        );
    }

    const appliedVersions: number[] = [];
    for (let version = fromVersion + 1; version <= toVersion; version++) {
        const migration = byVersion.get(version);
        if (!migration) {
            throw new Error(
                `Missing SQLite migration version ${version} for namespace "${options.sqlNamespace}".`
            );
        }
        let active = true;
        const context: SQLiteOntologyMigrationContext = {
            database: createGuardedMigrationDatabase(options.database, () => active),
            adapterName: options.adapterName,
            sqlNamespace: options.sqlNamespace,
            ir: options.ir,
            objectTableName: (objectTypeName) => options.objectTableName(objectTypeName),
        };
        let returned: unknown;
        try {
            returned = (migration.up as (context: SQLiteOntologyMigrationContext) => unknown)(context);
        } finally {
            active = false;
        }
        if (returned && typeof returned === "object" && "then" in returned) {
            void Promise.resolve(returned).catch(() => undefined);
            throw new Error(
                `SQLite migration version ${version} for "${options.adapterName}" returned a Promise; migrations must be synchronous.`
            );
        }
        options.database
            .prepare(
                `INSERT INTO party_stack_migrations (
                    namespace, version, name, applied_at
                 ) VALUES (?, ?, ?, ?)`
            )
            .run(options.sqlNamespace, version, migration.name ?? `migration-${version}`, Date.now());
        appliedVersions.push(version);
    }

    return {
        fromVersion,
        toVersion,
        appliedVersions,
    };
}

export function runSQLiteOntologyMigrations(
    options: Parameters<typeof runSQLiteOntologyMigrationsInTransaction>[0]
): SQLiteMigrationResult {
    let result: SQLiteMigrationResult | undefined;
    options.database.transaction(() => {
        result = runSQLiteOntologyMigrationsInTransaction(options);
    })();
    return result!;
}
