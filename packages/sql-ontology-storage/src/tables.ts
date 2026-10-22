import {
    makeTables,
    configurationError,
    storageError,
    transactionError,
    indexError,
    caseInsensitiveIndex,
    type DriverTransaction,
    type Entry,
    type Range,
    type StoredRow,
} from "@party-stack/ontology-storage/driver";
import { Tables, type OntologyStorageError } from "@party-stack/ontology-storage/tables";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";
import { arrayIndexExpression, compileQuery, indexExpression, literal, projectionKey } from "./compiler.js";

/** SQLite and PostgreSQL, through any Effect SqlClient driver for those dialects. */
export const make = Effect.fnUntraced(function* (options: { readonly prefix?: string } = {}) {
    const original = yield* SqlClient.SqlClient;
    const sql = original.withoutTransforms();
    const dialect = sql.onDialectOrElse({
        sqlite: () => "sqlite" as const,
        pg: () => "pg" as const,
        orElse: () => "unsupported" as const,
    });
    if (dialect === "unsupported")
        return yield* Effect.fail(
            configurationError("dialect", "Tables currently supports SQLite and PostgreSQL.")
        );
    const prefix = options.prefix ?? "party_tables";
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(prefix))
        return yield* Effect.fail(
            configurationError(
                "prefix",
                "SQL prefixes must be 1-40 lowercase ASCII letters, digits or underscores, starting with a letter."
            )
        );
    const rows = `${prefix}_rows`,
        definitions = `${prefix}_definitions`;
    // Binary collation is part of the portable index/key encoding contract.
    const text = dialect === "pg" ? 'TEXT COLLATE "C"' : "TEXT COLLATE BINARY";
    const q = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
    const run = <A extends object>(statement: Effect.Effect<readonly A[], unknown>) =>
        statement.pipe(
            Effect.mapError((cause) =>
                storageError("sql", "sql", cause, isSqlError(cause) && cause.isRetryable)
            )
        );
    yield* run(
        sql.unsafe(
            `CREATE TABLE IF NOT EXISTS ${q(rows)} (table_name ${text} NOT NULL, row_key ${text} NOT NULL, data TEXT NOT NULL, projection ${dialect === "pg" ? "JSONB" : "TEXT"} NOT NULL, PRIMARY KEY (table_name, row_key))`
        )
    );
    yield* run(
        sql.unsafe(
            `CREATE TABLE IF NOT EXISTS ${q(definitions)} (table_name ${text} NOT NULL, index_name ${text} NOT NULL, data TEXT NOT NULL, PRIMARY KEY (table_name,index_name))`
        )
    );
    return makeTables({
        transaction: (mode, body) =>
            Effect.suspend(() => {
                let active = false;
                let failed: OntologyStorageError | undefined;
                const check = <A>(effect: Effect.Effect<A, OntologyStorageError>) =>
                    Effect.suspend(() =>
                        active
                            ? effect.pipe(
                                  Effect.tapError((error) =>
                                      Effect.sync(() => {
                                          failed ??= error;
                                      })
                                  )
                              )
                            : Effect.fail(transactionError("Closed", "Transaction is closed"))
                    );
                const write = <A>(effect: Effect.Effect<A, OntologyStorageError>) =>
                    check(
                        mode === "readwrite"
                            ? effect.pipe(
                                  Effect.tapError((error) =>
                                      Effect.sync(() => {
                                          failed ??= error;
                                      })
                                  )
                              )
                            : Effect.fail(transactionError("ReadOnly", "Read-only transaction"))
                    );
                const conditions = (table: string, index: string, range: Range) => {
                    const expr = sql.literal(indexExpression(dialect, index));
                    const parts = [sql`table_name=${table}`, sql`${expr} IS NOT NULL`];
                    if (range.lower !== undefined)
                        parts.push(
                            range.lowerOpen ? sql`${expr} > ${range.lower}` : sql`${expr} >= ${range.lower}`
                        );
                    if (range.upper !== undefined)
                        parts.push(
                            range.upperOpen ? sql`${expr} < ${range.upper}` : sql`${expr} <= ${range.upper}`
                        );
                    if (range.after)
                        parts.push(
                            range.direction === "desc"
                                ? sql`(${expr} < ${range.after.value} OR (${expr}=${range.after.value} AND row_key < ${range.after.key}))`
                                : sql`(${expr} > ${range.after.value} OR (${expr}=${range.after.value} AND row_key > ${range.after.key}))`
                        );
                    return sql.and(parts);
                };
                const raw: DriverTransaction = {
                    nativeIndexes: true,
                    clear: (table) =>
                        write(
                            run(sql`DELETE FROM ${sql(rows)} WHERE table_name=${table}`).pipe(Effect.asVoid)
                        ),
                    query: (table, indexes, query) =>
                        check(
                            Effect.suspend(() => {
                                const compiled = compileQuery(dialect, indexes, query);
                                // Table/path literals are escaped and stable so the planner can
                                // match the exact partial expression index created by ensureIndex.
                                return run(
                                    sql.unsafe<{ row_key: string; data: string }>(
                                        `SELECT row_key,data FROM ${q(rows)} WHERE table_name=${literal(dialect, table.name)} AND (${compiled.condition}) ORDER BY ${compiled.order}${compiled.pagination}`,
                                        compiled.params
                                    )
                                ).pipe(
                                    Effect.map((result) => ({
                                        complete: compiled.complete,
                                        rows: result.map((row): StoredRow => ({
                                            table: table.name,
                                            key: row.row_key,
                                            data: row.data,
                                        })),
                                    }))
                                );
                            })
                        ),
                    get: (table, key) =>
                        check(
                            run(
                                sql<{
                                    data: string;
                                }>`SELECT data FROM ${sql(rows)} WHERE table_name=${table} AND row_key=${key}`
                            ).pipe(
                                Effect.map((result) =>
                                    result[0] ? { table, key, data: result[0].data } : undefined
                                )
                            )
                        ),
                    rows: (table) =>
                        check(
                            run(
                                sql<{
                                    row_key: string;
                                    data: string;
                                }>`SELECT row_key,data FROM ${sql(rows)} WHERE table_name=${table} ORDER BY row_key`
                            ).pipe(
                                Effect.map((result): StoredRow[] =>
                                    result.map((row) => ({ table, key: row.row_key, data: row.data }))
                                )
                            )
                        ),
                    put: (row) =>
                        write(
                            run(
                                sql`INSERT INTO ${sql(rows)} (table_name,row_key,data,projection) VALUES (${row.table},${row.key},${row.data},${JSON.stringify(Object.fromEntries(Object.entries(row.indexValues ?? {}).map(([name, value]) => [projectionKey(name), value])))}) ON CONFLICT (table_name,row_key) DO UPDATE SET data=excluded.data,projection=excluded.projection`
                            ).pipe(Effect.asVoid)
                        ),
                    delete: (table, key) =>
                        write(
                            run(
                                sql`DELETE FROM ${sql(rows)} WHERE table_name=${table} AND row_key=${key}`
                            ).pipe(Effect.asVoid)
                        ),
                    indexes: (table) =>
                        check(
                            run(
                                sql<{
                                    data: string;
                                }>`SELECT data FROM ${sql(definitions)} WHERE table_name=${table}`
                            ).pipe(
                                Effect.flatMap((result) =>
                                    Effect.try({
                                        try: () => result.map((row): unknown => JSON.parse(row.data)),
                                        catch: (cause) =>
                                            indexError("Invalid persisted index metadata", cause),
                                    })
                                )
                            )
                        ),
                    putIndex: (index) =>
                        write(
                            Effect.gen(function* () {
                                if (index.field.path.length) {
                                    if (index.multiEntry && dialect === "pg") {
                                        const name = `${prefix.slice(0, 20)}_i_${crypto.randomUUID().replaceAll("-", "")}`;
                                        yield* run(
                                            sql.unsafe(
                                                `CREATE INDEX ${q(name)} ON ${q(rows)} USING GIN ((${arrayIndexExpression(dialect, index.name)})) WHERE table_name=${literal(dialect, index.table)}`
                                            )
                                        );
                                    }
                                    for (const variant of index.multiEntry
                                        ? []
                                        : [index.name, caseInsensitiveIndex(index.name)]) {
                                        const name = `${prefix.slice(0, 20)}_i_${crypto.randomUUID().replaceAll("-", "")}`;
                                        const expr = indexExpression(dialect, variant);
                                        const unique = index.unique && variant === index.name;
                                        yield* run(
                                            sql.unsafe(
                                                `CREATE ${unique ? "UNIQUE " : ""}INDEX ${q(name)} ON ${q(rows)} (table_name, ${expr}${unique ? "" : ",row_key"}) WHERE table_name=${literal(dialect, index.table)}`
                                            )
                                        );
                                    }
                                }
                                yield* run(
                                    sql`INSERT INTO ${sql(definitions)} (table_name,index_name,data) VALUES (${index.table},${index.name},${JSON.stringify(index)})`
                                );
                            })
                        ),
                    // Backfill projections before installing native indexes.
                    putEntry: (entry) =>
                        write(
                            run(
                                entry.multiEntry
                                    ? dialect === "sqlite"
                                        ? sql`UPDATE ${sql(rows)} SET projection=json_insert(CASE WHEN json_type(projection, ${`$.${projectionKey(entry.index)}`}) IS NULL THEN json_set(projection, ${`$.${projectionKey(entry.index)}`}, json('[]')) ELSE projection END, ${`$.${projectionKey(entry.index)}[#]`}, ${entry.value}) WHERE table_name=${entry.table} AND row_key=${entry.key}`
                                        : sql`UPDATE ${sql(rows)} SET projection=jsonb_set(projection, ARRAY[${projectionKey(entry.index)}]::text[], COALESCE(projection -> ${projectionKey(entry.index)}, '[]'::jsonb) || to_jsonb(${entry.value}::text)) WHERE table_name=${entry.table} AND row_key=${entry.key}`
                                    : dialect === "sqlite"
                                      ? sql`UPDATE ${sql(rows)} SET projection=json_set(projection, ${`$.${projectionKey(entry.index)}`}, ${entry.value}) WHERE table_name=${entry.table} AND row_key=${entry.key}`
                                      : sql`UPDATE ${sql(rows)} SET projection=jsonb_set(projection, ARRAY[${projectionKey(entry.index)}]::text[], to_jsonb(${entry.value}::text)) WHERE table_name=${entry.table} AND row_key=${entry.key}`
                            ).pipe(Effect.asVoid)
                        ),
                    // Replacements write the complete projection; deletes remove the row.
                    deleteEntries: () => Effect.void,
                    countEntries: (table, index, range = {}) =>
                        check(
                            run(
                                sql<{
                                    count: number | string;
                                }>`SELECT COUNT(*) AS count FROM ${sql(rows)} WHERE ${conditions(table, index, range)}`
                            ).pipe(Effect.map((result) => Number(result[0]!.count)))
                        ),
                    entries: (table, index, range = {}) =>
                        check(
                            run(
                                sql<{
                                    value_key: string;
                                    row_key: string;
                                }>`SELECT ${sql.literal(indexExpression(dialect, index))} AS value_key,row_key FROM ${sql(rows)} WHERE ${conditions(table, index, range)} ORDER BY ${sql.literal(range.direction === "desc" ? "value_key DESC,row_key DESC" : "value_key,row_key")} ${range.limit === undefined ? sql.literal("") : sql`LIMIT ${range.limit}`}`
                            ).pipe(
                                Effect.map((result) =>
                                    result.map((entry): Entry => ({
                                        table,
                                        index,
                                        value: entry.value_key,
                                        key: entry.row_key,
                                    }))
                                )
                            )
                        ),
                };
                return sql
                    .withTransaction(
                        Effect.gen(function* () {
                            // Serialize across Tables instances sharing this PostgreSQL namespace.
                            // SQLite drivers use a writer transaction for the same guarantee.
                            // TODO: serializable PG transactions/retries and journal publication
                            // ordering should replace this coarse lock for concurrent workloads.
                            if (dialect === "pg")
                                yield* run(sql`SELECT pg_advisory_xact_lock(hashtext(${prefix}))`);
                            active = true;
                            const result = yield* Effect.suspend(() => body(raw));
                            // PostgreSQL can turn COMMIT into ROLLBACK after a caught
                            // statement error. Never report that as a successful commit.
                            if (failed) return yield* Effect.fail(failed);
                            return result;
                        })
                    )
                    .pipe(
                        Effect.onExit(() =>
                            Effect.sync(() => {
                                active = false;
                            })
                        ),
                        Effect.mapError((cause) =>
                            isSqlError(cause)
                                ? transactionError(
                                      "Backend",
                                      "SQL transaction failed",
                                      cause,
                                      isSqlError(cause) && cause.isRetryable
                                  )
                                : cause
                        )
                    );
            }),
    });
});
export const layer = (options?: { readonly prefix?: string }) => Layer.effect(Tables, make(options));
