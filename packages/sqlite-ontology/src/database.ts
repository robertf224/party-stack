/**
 * The complete synchronous SQLite surface used by the ontology adapter.
 *
 * This deliberately matches the corresponding subset of better-sqlite3, so an
 * existing better-sqlite3 Database can continue to be passed directly. Other
 * runtimes only need to adapt statement execution and synchronous transactions.
 */
export interface SQLiteStatement {
    all(...parameters: unknown[]): unknown[];
    get(...parameters: unknown[]): unknown;
    run(...parameters: unknown[]): unknown;
    readonly reader?: boolean;
}

export interface SQLiteDatabase {
    exec(sql: string): unknown;
    prepare(sql: string): SQLiteStatement;
    transaction(callback: () => void): () => void;
    transactionAsync?<A>(callback: () => Promise<A>): Promise<A>;
}

export type SQLiteDatabaseProvider = (ontologyId: string) => SQLiteDatabase | Promise<SQLiteDatabase>;
