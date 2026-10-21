import * as PgliteClient from "@effect/sql-pglite/PgLiteClient";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { Table } from "@party-stack/ontology-storage/tables";
import { runBlobContract, runContract, runOntologyContract } from "@party-stack/ontology-storage/testing";
import { Effect, Exit } from "effect";
import { test, expect } from "vitest";
import { make } from "./tables.js";

test("SQLite Tables and sparse overlays share the storage contract", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* make();
            yield* runContract(tables);
            yield* runOntologyContract(tables);
            yield* runBlobContract(tables);
        }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })))
    );
});
test("PostgreSQL Tables and sparse overlays share the storage contract", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* make();
            yield* runContract(tables);
            yield* runOntologyContract(tables);
            yield* runBlobContract(tables);
            const rows = Table.make<string>({ name: "statement_errors" });
            const tooLarge = Array.from({ length: 1000 }, () => crypto.randomUUID()).join("");
            const result = yield* Effect.exit(
                tables.transaction((tx) =>
                    Effect.gen(function* () {
                        yield* tx.put(rows, "before", "must roll back");
                        expect(Exit.isFailure(yield* Effect.exit(tx.put(rows, tooLarge, "bad")))).toBe(true);
                    })
                )
            );
            expect(Exit.isFailure(result)).toBe(true);
            expect(yield* tables.get(rows, "before")).toBeUndefined();
        }).pipe(Effect.provide(PgliteClient.layer()))
    );
}, 30000);

test("Corrupt persisted index metadata is an expected IndexError", async () => {
    const Sql = await import("effect/sql/SqlClient");
    await Effect.runPromise(
        Effect.gen(function* () {
            const sql = yield* Sql.SqlClient;
            const tables = yield* make();
            const rows = Table.make<number>({ name: "corrupt" });
            yield* tables.put(rows, "key", 1);
            yield* sql`UPDATE party_tables_definitions SET data=${JSON.stringify({ name: 7 })} WHERE table_name=${rows.name}`;
            const recovered = yield* tables.get(rows, "key").pipe(
                Effect.as(false),
                Effect.catchReason("OntologyStorageError", "IndexError", (reason) =>
                    Effect.succeed(reason.message.includes("metadata"))
                )
            );
            expect(recovered).toBe(true);
        }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })))
    );
});
