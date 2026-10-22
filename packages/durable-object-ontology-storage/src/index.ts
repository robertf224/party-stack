import { BackendError } from "@party-stack/ontology-backend";
import { exclusiveOwnerLiveness, type BlobBytesService } from "@party-stack/ontology-storage/blobs";
import { Table } from "@party-stack/ontology-storage/tables";
import * as SQLite from "@party-stack/sql-ontology-storage/sqlite";
import { Effect } from "effect";
export { makeR2Bytes, r2BytesLayer, destroyDurableObjectOntologyStorage } from "./r2.js";
export type { R2BytesOptions } from "./r2.js";
import type { SQLiteDatabase, SQLiteStatement } from "@party-stack/sql-ontology-storage/sqlite";

export interface DurableObjectSqlCursor {
    toArray(): Record<string, unknown>[];
}

export type DurableObjectSqlBinding = ArrayBuffer | string | number | null;

export interface DurableObjectSqlStorage {
    exec(query: string, ...bindings: DurableObjectSqlBinding[]): DurableObjectSqlCursor;
}

export interface DurableObjectSQLiteStorage {
    readonly sql: DurableObjectSqlStorage;
    transactionSync<Result>(callback: () => Result): Result;
    transaction?<Result>(callback: () => Promise<Result>): Promise<Result>;
    deleteAll(): Promise<void>;
}

export interface DurableObjectSQLiteDatabase extends SQLiteDatabase {
    prepare(sql: string): SQLiteStatement & { get(...parameters: unknown[]): unknown };
    transaction(body: () => void): () => void;
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

function createStatement(
    sql: DurableObjectSqlStorage,
    query: string
): SQLiteStatement & { get(...parameters: unknown[]): unknown } {
    const execute = (bindings: unknown[]) => sql.exec(query, ...bindings.map(normalizeBinding));
    return {
        all: (...bindings) => execute(bindings).toArray(),
        get: (...bindings) => execute(bindings).toArray()[0],
        run: (...bindings) => execute(bindings),
    };
}

const databases = new WeakMap<DurableObjectSQLiteStorage, DurableObjectSQLiteDatabase>();
export function createDurableObjectSQLiteDatabase(
    storage: DurableObjectSQLiteStorage
): DurableObjectSQLiteDatabase {
    const previous = databases.get(storage);
    if (previous) return previous;
    const database: DurableObjectSQLiteDatabase = {
        exec: (sql) => storage.sql.exec(sql),
        prepare: (sql) => createStatement(storage.sql, sql),
        transaction: (callback) => () => {
            storage.transactionSync(callback);
        },
        ...(storage.transaction
            ? { transactionAsync: <A>(callback: () => Promise<A>) => storage.transaction!(callback) }
            : {}),
        destroy: () => storage.deleteAll(),
    };
    databases.set(storage, database);
    return database;
}

/** Supply the standard Effect SQL client from DO SQL and its native transaction boundary. */
export const sqlLayer = (storage: DurableObjectSQLiteStorage) =>
    SQLite.layer(createDurableObjectSQLiteDatabase(storage));

export interface DurableObjectOntologyStorageOptions {
    readonly storage: DurableObjectSQLiteStorage;
    readonly ontologyId: string;
    readonly namespace?: string;
    /** Defaults to the shared inline SQLite byte store. */
    readonly bytes?: BlobBytesService;
}

/** Shared SQL Tables/blob composition. Platform bridges add no action or GC implementation. */
export const makeDurableObjectOntologyStorage = Effect.fn("DurableObjectStorage.make")(function* (
    options: DurableObjectOntologyStorageOptions
) {
    const namespace = options.namespace ?? options.ontologyId;
    const storage = yield* SQLite.makeStorage(createDurableObjectSQLiteDatabase(options.storage), {
        namespace,
        bytes: options.bytes,
        mode: "authoritative",
        ownerLiveness: exclusiveOwnerLiveness(options.storage),
    });
    const identity = Table.make<{ ontologyId: string }>({ name: "party-stack:durable-object:ontology" });
    yield* storage.tables.transaction((tx) =>
        Effect.gen(function* () {
            const previous = yield* tx.get(identity, "identity");
            if (previous && previous.ontologyId !== options.ontologyId)
                return yield* new BackendError({
                    operation: "ontology",
                    kind: "Conflict",
                    message:
                        "A Durable Object hosts one ontology; use a different object for another ontology.",
                    retryable: false,
                });
            yield* tx.put(identity, "identity", { ontologyId: options.ontologyId });
        })
    );
    return storage;
});
