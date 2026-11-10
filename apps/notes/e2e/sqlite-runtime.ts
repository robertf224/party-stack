import { make as makeSqliteClient } from "@effect/sql-sqlite-wasm/SqliteClient";
import { RuntimeError, RuntimePartition } from "@party-stack/runtime";
import { make as makeSqlTables } from "@party-stack/sql-ontology-storage/tables";
import { webRuntime } from "@party-stack/web-runtime";
import { Effect, Layer } from "effect";
import { layer as reactivityLayer } from "effect/reactivity/Reactivity";
import { SqlClient } from "effect/sql/SqlClient";

export const sqliteOpfsRuntime = (port: MessagePort) => {
    const sqlLayer = Layer.effect(
        SqlClient,
        makeSqliteClient({
            worker: Effect.succeed(port),
        }).pipe(
            Effect.withSpan("Notes.sqlite.open"),
            Effect.mapError((cause) => new RuntimeError({ operation: "notes.sqlite.open", cause }))
        )
    ).pipe(Layer.provide(reactivityLayer));

    /** Opt-in benchmark composition; normal Notes persistence remains IndexedDB. */
    return Layer.unwrap(
        Effect.map(SqlClient, (sql) =>
            webRuntime({
                persistEncryptionKeys: true,
                tables: Effect.gen(function* () {
                    const partition = yield* RuntimePartition;
                    const digest = yield* Effect.tryPromise({
                        try: () =>
                            crypto.subtle.digest(
                                "SHA-256",
                                new TextEncoder().encode(JSON.stringify(partition))
                            ),
                        catch: (cause) => new RuntimeError({ operation: "notes.sqlite.partition", cause }),
                    });
                    const prefix = `notes_${Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
                    const tables = yield* makeSqlTables({ prefix }).pipe(
                        Effect.provideService(SqlClient, sql)
                    );
                    return {
                        tables,
                        // The enclosing worker layer owns the SQL client, so this still
                        // works after the individual partition lease has been released.
                        destroy: sql
                            .withTransaction(
                                Effect.gen(function* () {
                                    yield* sql.unsafe(`DROP TABLE IF EXISTS "${prefix}_rows"`);
                                    yield* sql.unsafe(`DROP TABLE IF EXISTS "${prefix}_definitions"`);
                                })
                            )
                            .pipe(
                                Effect.mapError(
                                    (cause) => new RuntimeError({ operation: "notes.sqlite.destroy", cause })
                                )
                            ),
                    };
                }),
            })
        )
    ).pipe(Layer.provide(sqlLayer));
};
