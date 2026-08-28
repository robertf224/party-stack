import type { SQLiteDatabase, SQLiteStatement } from "@party-stack/sqlite-ontology";

export interface DurableObjectSqlCursor {
    toArray(): Record<string, unknown>[];
}

export type DurableObjectSqlBinding = ArrayBuffer | string | number | null;

export interface DurableObjectSqlStorage {
    exec(query: string, ...bindings: DurableObjectSqlBinding[]): DurableObjectSqlCursor;
}

/**
 * The DurableObjectStorage subset required by the SQLite adapter.
 *
 * A Cloudflare DurableObjectStorage is structurally assignable to this type.
 * Keeping the surface explicit also makes the adapter usable by compatible
 * workerd hosts without leaking Cloudflare types into the core ontology.
 */
export interface DurableObjectSQLiteStorage {
    readonly sql: DurableObjectSqlStorage;
    transactionSync<Result>(callback: () => Result): Result;
    deleteAll(): Promise<void>;
}

export interface DurableObjectSQLiteDatabase extends SQLiteDatabase {
    /**
     * Deletes all SQL, key/value, and alarm state owned by the Durable Object.
     */
    destroy(): Promise<void>;
}

function normalizeBinding(binding: unknown): DurableObjectSqlBinding {
    if (ArrayBuffer.isView(binding)) {
        return new Uint8Array(binding.buffer, binding.byteOffset, binding.byteLength).slice().buffer;
    }
    if (
        binding === null ||
        typeof binding === "string" ||
        typeof binding === "number" ||
        binding instanceof ArrayBuffer
    ) {
        return binding;
    }
    throw new TypeError(`Unsupported Durable Object SQL binding: ${typeof binding}.`);
}

function createStatement(sql: DurableObjectSqlStorage, query: string): SQLiteStatement {
    const execute = (bindings: unknown[]) => sql.exec(query, ...bindings.map(normalizeBinding));
    return {
        all: (...bindings) => execute(bindings).toArray(),
        get: (...bindings) => execute(bindings).toArray()[0],
        run: (...bindings) => execute(bindings),
    };
}

/**
 * Adapts DurableObjectStorage.sql and transactionSync to Party Stack's
 * synchronous SQLite port. Construction is synchronous, so schema
 * initialization can run inside DurableObjectState.blockConcurrencyWhile.
 */
export function createDurableObjectSQLiteDatabase(
    storage: DurableObjectSQLiteStorage
): DurableObjectSQLiteDatabase {
    return {
        exec: (sql) => storage.sql.exec(sql),
        prepare: (sql) => createStatement(storage.sql, sql),
        transaction: (callback) => () => {
            storage.transactionSync(callback);
        },
        destroy: () => storage.deleteAll(),
    };
}
