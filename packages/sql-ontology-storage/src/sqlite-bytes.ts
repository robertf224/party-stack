import { BlobBytes, byteChunks, type ByteInput } from "@party-stack/ontology-storage/blobs";
import { Effect, Option, Stream } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";

/** Private chunks are visible only after EOF. Metadata/GC publishes and deletes their immutable key. */
export const makeBytes = Effect.fn("SQLiteOntology.blobBytes")(function* (sql: SqlClient) {
    yield* sql`CREATE TABLE IF NOT EXISTS party_blob_generations (byte_key TEXT PRIMARY KEY, size INTEGER NOT NULL)`;
    yield* sql`CREATE TABLE IF NOT EXISTS party_blob_chunks (byte_key TEXT NOT NULL, part INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (byte_key,part))`;
    return BlobBytes.of({
        write: Effect.fn("SQLiteOntology.writeBytes")(function* (key: string, input: ByteInput) {
            let size = 0;
            let part = 0;
            yield* Stream.runForEach(byteChunks(input), (bytes) =>
                Effect.gen(function* () {
                    yield* sql`INSERT INTO party_blob_chunks (byte_key,part,bytes) VALUES (${key},${part++},${bytes})`;
                    size += bytes.length;
                })
            );
            yield* sql`INSERT INTO party_blob_generations (byte_key,size) VALUES (${key},${size})`;
        }),
        read: Effect.fn("SQLiteOntology.readBytes")(function* (key: string) {
            const rows = yield* sql<{
                size: number;
            }>`SELECT size FROM party_blob_generations WHERE byte_key=${key}`;
            if (!rows[0]) return undefined;
            return {
                size: rows[0].size,
                type: "application/octet-stream",
                stream: Stream.paginate(0, (part) =>
                    Effect.gen(function* () {
                        const rows = yield* sql<{
                            bytes: unknown;
                        }>`SELECT bytes FROM party_blob_chunks WHERE byte_key=${key} AND part=${part}`;
                        const value = rows[0]?.bytes;
                        if (value === undefined) return [[], Option.none()] as const;
                        const bytes =
                            value instanceof ArrayBuffer
                                ? new Uint8Array(value)
                                : ArrayBuffer.isView(value)
                                  ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
                                  : undefined;
                        if (!bytes)
                            return yield* Effect.fail(new TypeError("Attachment chunk is not a BLOB."));
                        return [[bytes], Option.some(part + 1)] as const;
                    })
                ),
            };
        }),
        delete: (key) =>
            sql.withTransaction(
                Effect.gen(function* () {
                    yield* sql`DELETE FROM party_blob_chunks WHERE byte_key=${key}`;
                    yield* sql`DELETE FROM party_blob_generations WHERE byte_key=${key}`;
                })
            ),
    });
});
