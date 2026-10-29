import { storageError } from "@party-stack/ontology-storage/driver";
import { Runtime, RuntimeError, RuntimePartition, makeKeyMaterialStoreKeyring } from "@party-stack/runtime";
import * as SQLite from "@party-stack/sql-ontology-storage/sqlite";
import * as SqlTables from "@party-stack/sql-ontology-storage/tables";
import { Effect, Layer, Schema } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { deleteDatabaseAsync, openDatabaseAsync } from "expo-sqlite";
import { createExpoBrowserAuthentication } from "./createExpoBrowserAuthentication.js";
import { nativeKeyCodec } from "./encryptionKeys.js";
import { ExpoFileSystemBlobBytesStore } from "./ExpoFileSystemBlobBytesStore.js";
import { makeKeyMaterialStore } from "./ExpoKeyMaterialStore.js";
import { makeExpoNetworkConnectivity } from "./ExpoNetworkConnectivity.js";
import { hashStorageName } from "./hashStorageName.js";
import type { SQLiteBindValue } from "expo-sqlite";

export const make = Effect.fn("ExpoRuntime.make")(function* () {
    const { owner, namespace } = yield* RuntimePartition;
    const name = `party-stack:${owner}:${namespace}`;
    const storageName = `party-stack-${yield* Effect.tryPromise({ try: () => hashStorageName(JSON.stringify([owner, namespace])), catch: (cause) => new RuntimeError({ operation: "expoRuntime.name", cause }) })}`;
    const connectivity = yield* makeExpoNetworkConnectivity();
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
export const layer = () => Layer.effect(Runtime, make());
