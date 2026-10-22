import { BlobBytes } from "@party-stack/ontology-storage/blobs";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";

/** Only byte IO is platform-specific; metadata, references and GC use BlobStorage. */
export const makeBytes = Effect.fn("SQLiteOntology.blobBytes")(function* (sql: SqlClient) {
    yield* sql`CREATE TABLE IF NOT EXISTS party_blob_bytes (byte_key TEXT PRIMARY KEY, bytes BLOB NOT NULL)`;
    return BlobBytes.of({
        write: Effect.fn("SQLiteOntology.writeBytes")(function* (key: string, blob: Blob) {
            const bytes = new Uint8Array(yield* Effect.tryPromise(() => blob.arrayBuffer()));
            yield* sql`INSERT INTO party_blob_bytes (byte_key,bytes) VALUES (${key},${bytes}) ON CONFLICT(byte_key) DO UPDATE SET bytes=excluded.bytes`;
        }),
        read: Effect.fn("SQLiteOntology.readBytes")(function* (key: string) {
            const rows = yield* sql<{
                bytes: unknown;
            }>`SELECT bytes FROM party_blob_bytes WHERE byte_key=${key}`;
            const value = rows[0]?.bytes;
            if (value === undefined) return undefined;
            if (value instanceof ArrayBuffer) return new Blob([value]);
            if (ArrayBuffer.isView(value))
                return new Blob([
                    new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer,
                ]);
            return yield* Effect.fail(new TypeError("Attachment bytes are not a BLOB."));
        }),
        delete: (key) => sql`DELETE FROM party_blob_bytes WHERE byte_key=${key}`.pipe(Effect.asVoid),
    });
});
