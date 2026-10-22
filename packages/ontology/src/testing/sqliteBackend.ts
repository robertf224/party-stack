import { BackendError } from "@party-stack/ontology-backend";
import * as SQLite from "@party-stack/sql-ontology-storage/sqlite";
import { Effect } from "effect";
import { makeStorageOntologyBackend, type StorageOntologyBackendOptions } from "../live/storageBackend.js";
export interface SQLiteDatabase extends SQLite.SQLiteDatabase {
    prepare(sql: string): SQLite.SQLiteStatement & { get(...parameters: unknown[]): unknown };
    transaction(body: () => void): () => void;
}
export interface SQLiteAttachmentBytesStore {
    write(id: string, blob: Blob): Promise<void>;
    read(id: string): Promise<Blob | undefined>;
    delete(id: string): Promise<void>;
}
export interface SQLiteAttachmentStorageOptions {
    external?: { bytes: SQLiteAttachmentBytesStore };
}
type Options = Omit<StorageOntologyBackendOptions, "namespace" | "tables" | "blobs"> & {
    database: SQLiteDatabase;
    name?: string;
    attachmentStorage?: SQLiteAttachmentStorageOptions;
};
export const makeSQLiteTestBackend = Effect.fnUntraced(
    function* (options: Options) {
        const namespace = options.name ?? "sqlite";
        const external = options.attachmentStorage?.external;
        const storage = yield* SQLite.makeStorage(options.database, {
            namespace,
            mode: "authoritative",
            bytes: external
                ? {
                      read: (key) => Effect.tryPromise(() => external.bytes.read(key)),
                      write: (key, blob) => Effect.tryPromise(() => external.bytes.write(key, blob)),
                      delete: (key) => Effect.tryPromise(() => external.bytes.delete(key)),
                  }
                : undefined,
        });
        return yield* makeStorageOntologyBackend({ ...options, ...storage, namespace });
    },
    Effect.mapError((cause) =>
        cause instanceof BackendError
            ? cause
            : new BackendError({
                  operation: "sqlite.open",
                  kind: "Unavailable",
                  message: "SQLite storage failed.",
                  retryable: false,
                  cause,
              })
    )
);
export const createSQLiteTestBackend = (options: Options) => ({
    name: options.name ?? "sqlite",
    open: (context: Record<string, unknown>) => makeSQLiteTestBackend({ ...options, context }),
});
