import { DatabaseSync } from "node:sqlite";
import { byteChunks } from "@party-stack/ontology-storage/blobs";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Exit, Stream } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { expect, test } from "vitest";
import { makeBytes } from "./sqlite-bytes.js";
import { layer, type SQLiteDatabase } from "./sqlite.js";
import { make } from "./tables.js";

for (const native of [false, true])
    test(`existing SQLite bridge preserves async rollback and cancellation (native=${native})`, async () => {
        const db = new DatabaseSync(":memory:");
        let commits = 0;
        let rollbacks = 0;
        const database: SQLiteDatabase = {
            prepare: (query) => db.prepare(query) as unknown as ReturnType<SQLiteDatabase["prepare"]>,
            exec: (query) => db.exec(query),
            ...(native
                ? {
                      transactionAsync: async <A>(body: () => Promise<A>) => {
                          db.exec("BEGIN IMMEDIATE");
                          try {
                              const value = await body();
                              db.exec("COMMIT");
                              commits++;
                              return value;
                          } catch (error) {
                              db.exec("ROLLBACK");
                              rollbacks++;
                              throw error;
                          }
                      },
                  }
                : {}),
        };
        try {
            await Effect.runPromise(
                Effect.gen(function* () {
                    const sql = yield* SqlClient.SqlClient;
                    const tables = yield* make();
                    const table = Table.make<number>({ name: "bridge" });
                    yield* tables.put(table, "before", 1);
                    const outcome = yield* Effect.exit(
                        tables.transaction((tx) =>
                            Effect.gen(function* () {
                                yield* tx.put(table, "failed", 2);
                                const context = yield* Effect.context<never>();
                                // TanStack callbacks must inherit the SQL transaction, including across Promises.
                                yield* Effect.promise(() =>
                                    Effect.runPromiseWith(context)(tables.put(table, "callback", 3))
                                );
                                yield* Effect.fail("rollback");
                            })
                        )
                    );
                    expect(Exit.isFailure(outcome)).toBe(true);
                    expect(yield* tables.get(table, "failed")).toBeUndefined();
                    expect(yield* tables.get(table, "callback")).toBeUndefined();
                    const controller = new AbortController();
                    const context = yield* Effect.context<never>();
                    const cancelled = Effect.runPromiseExitWith(context)(
                        tables.transaction((tx) =>
                            Effect.gen(function* () {
                                yield* tx.put(table, "cancelled", 4);
                                controller.abort();
                                yield* Effect.never;
                            })
                        ),
                        { signal: controller.signal }
                    );
                    expect(Exit.isFailure(yield* Effect.promise(() => cancelled))).toBe(true);
                    expect(yield* tables.get(table, "cancelled")).toBeUndefined();
                    expect(yield* tables.get(table, "before")).toBe(1);
                    yield* sql.withTransaction(sql`SELECT 1`);
                }).pipe(Effect.provide(layer(database)))
            );
            expect(native ? commits > 0 : commits === 0).toBe(true);
            expect(rollbacks).toBe(native ? 2 : 0);
        } finally {
            db.close();
        }
    });

test("SQLite byte IO streams large objects through bounded BLOB rows", async () => {
    const db = new DatabaseSync(":memory:");
    const database: SQLiteDatabase = {
        prepare: (query) => db.prepare(query) as unknown as ReturnType<SQLiteDatabase["prepare"]>,
        exec: (query) => db.exec(query),
    };
    try {
        await Effect.runPromise(
            Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const bytes = yield* makeBytes(sql);
                yield* bytes.write("large", {
                    type: "application/octet-stream",
                    stream: Stream.succeed(new Uint8Array(3 * 1024 * 1024)),
                });
                const stats = yield* sql<{
                    maximum: number;
                    count: number;
                }>`SELECT MAX(length(bytes)) AS maximum, COUNT(*) AS count FROM party_blob_chunks`;
                expect(stats[0]).toEqual({ maximum: 64 * 1024, count: 48 });
                const source = yield* bytes.read("large");
                expect(source?.size).toBe(3 * 1024 * 1024);
                expect(
                    yield* byteChunks(source!).pipe(
                        Stream.runFold(
                            () => 0,
                            (total, chunk) => total + chunk.length
                        )
                    )
                ).toBe(3 * 1024 * 1024);
                yield* bytes.delete("large");
                expect(yield* bytes.read("large")).toBeUndefined();
                expect(
                    (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM party_blob_chunks`)[0]?.count
                ).toBe(0);
            }).pipe(Effect.provide(layer(database)))
        );
    } finally {
        db.close();
    }
});
