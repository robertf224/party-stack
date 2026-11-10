import { storageError } from "@party-stack/ontology-storage/driver";
import * as MemoryTables from "@party-stack/ontology-storage/memory/tables";
import { Runtime, RuntimeError, RuntimePartition, makeKeyMaterialStoreKeyring } from "@party-stack/runtime";
import { Runtimes, MemoryBlobBytesStore, type KeyMaterialStore } from "@party-stack/runtime";
import * as SQLite from "@party-stack/sql-ontology-storage/sqlite";
import * as SqlTables from "@party-stack/sql-ontology-storage/tables";
import { Effect, Layer, Schema } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { Paths } from "expo-file-system";
import { deleteDatabaseAsync, openDatabaseAsync } from "expo-sqlite";
import { createExpoBrowserAuthentication } from "./createExpoBrowserAuthentication.js";
import { nativeKeyCodec } from "./encryptionKeys.js";
import { ExpoFileSystemBlobBytesStore } from "./ExpoFileSystemBlobBytesStore.js";
import { makeKeyMaterialStore } from "./ExpoKeyMaterialStore.js";
import { makeExpoNetworkConnectivity } from "./ExpoNetworkConnectivity.js";
import { hashStorageName } from "./hashStorageName.js";
import type { SQLiteBindValue } from "expo-sqlite";

export interface ExpoRuntimeOptions {
    /** Persistent SQLite/filesystem storage by default; memory keeps native platform capabilities. */
    readonly storage?: "persistent" | "memory";
}

export const make = Effect.fn("ExpoRuntime.make")(function* (options: ExpoRuntimeOptions = {}) {
    const { owner, namespace } = yield* RuntimePartition;
    const connectivity = yield* makeExpoNetworkConnectivity();
    if (options.storage === "memory") {
        const materials = new Map<string, string>();
        const secrets: KeyMaterialStore = {
            get: (id) => Effect.sync(() => materials.get(id)),
            set: (id, value) =>
                Effect.sync(() => {
                    materials.set(id, value);
                }),
            delete: (id) =>
                Effect.sync(() => {
                    materials.delete(id);
                }),
        };
        return yield* Runtime.make({
            tables: yield* MemoryTables.make(),
            blobBytes: new MemoryBlobBytesStore(),
            encryptionKeyring: yield* makeKeyMaterialStoreKeyring(secrets, nativeKeyCodec),
            browserAuthentication: createExpoBrowserAuthentication(),
            connectivity,
            capacity: { memory: Effect.succeed(undefined), storage: Effect.succeed(undefined) },
        });
    }
    const name = `party-stack:${owner}:${namespace}`;
    const storageName = `party-stack-${yield* Effect.tryPromise({ try: () => hashStorageName(JSON.stringify([owner, namespace])), catch: (cause) => new RuntimeError({ operation: "expoRuntime.name", cause }) })}`;
    const blobBytes = new ExpoFileSystemBlobBytesStore({
        directoryName: `${storageName}-blobs`,
    });
    const tables = Effect.gen(function* () {
        const database = yield* Effect.acquireRelease(
            Effect.tryPromise({
                try: () => openDatabaseAsync(`${storageName}-storage.db`),
                catch: (cause) => storageError("sql", "open", cause),
            }),
            (database) => Effect.promise(() => database.closeAsync())
        );
        let active = database;
        const sql = yield* SQLite.makeClient({
            exec: (query) => active.execSync(query),
            prepare: (query) => ({
                all: (...values) => active.getAllSync(query, values as SQLiteBindValue[]),
                run: (...values) => active.runSync(query, values as SQLiteBindValue[]),
            }),
            transactionAsync: <A>(body: () => Promise<A>) => {
                let value: A;
                return database
                    .withExclusiveTransactionAsync(async (tx) => {
                        active = tx;
                        try {
                            value = await body();
                        } finally {
                            active = database;
                        }
                    })
                    .then(() => value);
            },
        }).pipe(
            Effect.provide(Reactivity.layer),
            Effect.mapError((cause) => storageError("sql", "open", cause))
        );
        return yield* SqlTables.make().pipe(Effect.provideService(SqlClient.SqlClient, sql));
    });
    const secrets = makeKeyMaterialStore(`${name}:secrets`);
    const ownedTables = yield* tables;
    const encryptionKeyring = yield* makeKeyMaterialStoreKeyring(secrets, nativeKeyCodec);
    return yield* Runtime.make({
        blobBytes,
        capacity: {
            memory: Effect.succeed(undefined),
            storage: Effect.try({
                try: () => ({
                    scope: "filesystem" as const,
                    limitBytes: Paths.totalDiskSpace,
                    availableBytes: Paths.availableDiskSpace,
                }),
                catch: (cause) => new RuntimeError({ operation: "capacity.storage", cause }),
            }),
        },
        browserAuthentication: createExpoBrowserAuthentication(),
        encryptionKeyring,
        connectivity,

        tables: ownedTables,
        destroy: Effect.tryPromise({
            try: async () => {
                await Promise.all([
                    deleteDatabaseAsync(`${storageName}-storage.db`).catch((cause) => {
                        if (
                            !Schema.is(Schema.Struct({ code: Schema.Literal("ERR_DATABASE_NOT_FOUND") }))(
                                cause
                            )
                        )
                            throw cause;
                    }),
                    Effect.runPromise(blobBytes.clear()),
                ]);
            },
            catch: (cause) => new RuntimeError({ operation: "destroy", cause }),
        }),
    });
});
export const layer = (options: ExpoRuntimeOptions = {}) => Layer.effect(Runtime, make(options));
export const expoRuntime = (options: ExpoRuntimeOptions = {}) =>
    Runtimes.layer(layer(options), { browserAuthentication: createExpoBrowserAuthentication() });
