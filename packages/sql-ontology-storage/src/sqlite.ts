import {
    makeBlobStorage,
    type BlobBytesService,
    type BlobStorageOptions,
} from "@party-stack/ontology-storage/blobs";
import { Effect, Exit, Layer, Semaphore, Stream, Scheduler } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { classifySqliteError, SqlError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";
import { makeBytes } from "./sqlite-bytes.js";
import * as SqlTables from "./tables.js";
import type { Cause } from "effect";
import type { Connection } from "effect/sql/SqlConnection";

export interface SQLiteStatement {
    all(...parameters: unknown[]): unknown[];
    run(...parameters: unknown[]): unknown;
    readonly reader?: boolean;
}
export interface SQLiteDatabase {
    prepare(sql: string): SQLiteStatement;
    exec(sql: string): unknown;
    /** Platform-native asynchronous transaction, e.g. DurableObjectStorage.transaction. */
    transactionAsync?<A>(body: () => Promise<A>): Promise<A>;
}
class NativeTransactionFailure {
    constructor(readonly cause: Cause.Cause<unknown>) {}
}
const sqlError = (cause: unknown) =>
    new SqlError({
        reason: classifySqliteError(cause, { message: "SQLite execution failed", operation: "execute" }),
    });
const gates = new WeakMap<SQLiteDatabase, ReturnType<typeof Semaphore.makeUnsafe>>();

/** Adapt an existing synchronous SQLite connection without assuming ownership of its lifetime. */
export const makeClient = Effect.fnUntraced(function* (database: SQLiteDatabase) {
    const gate = yield* Effect.sync(() => {
        const existing = gates.get(database);
        if (existing) return existing;
        const created = Semaphore.makeUnsafe(1);
        gates.set(database, created);
        return created;
    });
    const execute = (sql: string, parameters: readonly unknown[]) =>
        Effect.try({
            try: () => {
                const statement = database.prepare(sql);
                if (statement.reader === false) {
                    statement.run(...parameters);
                    return [] as readonly Record<string, unknown>[];
                }
                return statement.all(...parameters) as readonly Record<string, unknown>[];
            },
            catch: sqlError,
        });
    const connection: Connection = {
        execute: (sql, parameters, transform) =>
            transform ? Effect.map(execute(sql, parameters), transform) : execute(sql, parameters),
        executeRaw: execute,
        executeUnprepared: (sql, parameters, transform) =>
            transform ? Effect.map(execute(sql, parameters), transform) : execute(sql, parameters),
        executeValues: (sql, parameters) =>
            Effect.map(execute(sql, parameters), (rows) => rows.map(Object.values)),
        executeValuesUnprepared: (sql, parameters) =>
            Effect.map(execute(sql, parameters), (rows) => rows.map(Object.values)),
        executeStream: (sql, parameters, transform) =>
            Stream.fromEffect(
                transform ? Effect.map(execute(sql, parameters), transform) : execute(sql, parameters)
            ).pipe(Stream.flatMap(Stream.fromIterable)),
    };
    const acquirer = Effect.acquireRelease(gate.take(1), () => gate.release(1)).pipe(Effect.as(connection));
    const client = yield* SqlClient.make({
        acquirer,
        compiler: Statement.makeCompilerSqlite(),
        beginTransaction: "BEGIN IMMEDIATE",
        releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
        spanAttributes: [["db.system.name", "sqlite"]],
    });
    if (database.transactionAsync) {
        const transactionAsync = database.transactionAsync.bind(database);
        // Request-owned scheduler timers can be blocked or discarded by a Durable
        // Object transaction. Keep fiber dispatch synchronous inside the native gate.
        const transactionScheduler = new Scheduler.MixedScheduler("sync");
        const native = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError, R> =>
            gate.withPermits(1)(
                Effect.flatMap(Effect.context<R>(), (context) =>
                    Effect.callback<A, E | SqlError>((resume) => {
                        const controller = new AbortController();
                        const pending = transactionAsync(async () => {
                            const exit = await Effect.runPromiseExitWith(context)(
                                effect.pipe(
                                    Effect.provideService(client.transactionService, [connection, 0]),
                                    Effect.provideService(Scheduler.Scheduler, transactionScheduler)
                                ),
                                { signal: controller.signal }
                            );
                            if (Exit.isFailure(exit)) throw new NativeTransactionFailure(exit.cause);
                            return exit.value;
                        }).then(
                            (value) => Exit.succeed(value),
                            (cause): Exit.Exit<A, E | SqlError> =>
                                cause instanceof NativeTransactionFailure
                                    ? Exit.failCause(cause.cause as Cause.Cause<E>)
                                    : Exit.fail(sqlError(cause))
                        );
                        void pending.then((exit) => resume(exit));
                        // Native rollback must finish before the connection's scope can close.
                        return Effect.promise(async () => {
                            controller.abort();
                            await pending;
                        });
                    })
                )
            );
        return Object.assign(client, { withTransaction: native, withoutTransforms: () => client });
    }
    return client;
});

export const layer = (database: SQLiteDatabase) =>
    Layer.effect(SqlClient.SqlClient, makeClient(database)).pipe(Layer.provide(Reactivity.layer));

/** SQLite byte storage is replaceable independently of Tables. */
export { makeBytes } from "./sqlite-bytes.js";

/** Convenience composition; clients can also supply SqlClient, Tables and BlobBytes Layers separately. */
export const makeStorage = Effect.fn("SQLiteStorage.make")(function* (
    database: SQLiteDatabase,
    options: {
        readonly namespace: string;
        readonly bytes?: BlobBytesService;
        readonly mode?: "replica" | "authoritative";
        readonly ownerLiveness?: Pick<BlobStorageOptions, "registerOwner" | "isOwnerAlive">;
    }
) {
    const sql = yield* makeClient(database).pipe(Effect.provide(Reactivity.layer));
    const tables = yield* SqlTables.make().pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const bytes = options.bytes ?? (yield* makeBytes(sql));
    const blobs = yield* makeBlobStorage({
        namespace: options.namespace,
        mode: options.mode,
        tables,
        bytes,
        ...options.ownerLiveness,
    });
    return { tables, blobs };
});
