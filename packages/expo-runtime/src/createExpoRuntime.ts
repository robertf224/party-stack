import { storageError } from "@party-stack/ontology-storage/driver";
import { Runtime, RuntimeError, makeSecretStoreKeyring } from "@party-stack/runtime";
import * as SQLite from "@party-stack/sql-ontology-storage/sqlite";
import * as SqlTables from "@party-stack/sql-ontology-storage/tables";
import { Effect, Layer, Schema } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { deleteDatabaseAsync, openDatabaseAsync } from "expo-sqlite";
import { createExpoBrowserAuthentication } from "./createExpoBrowserAuthentication.js";
import { nativeKeyCodec } from "./encryptionKeys.js";
import { ExpoFileSystemBlobBytesStore } from "./ExpoFileSystemBlobBytesStore.js";
import { ExpoNetworkConnectivity } from "./ExpoNetworkConnectivity.js";
import { makeSecretStore } from "./ExpoSecretStore.js";
import { hashStorageName } from "./hashStorageName.js";
import type { SQLiteBindValue } from "expo-sqlite";

export interface ExpoRuntimeOptions {
    readonly owner: string;
    readonly namespace: string;
}

export const make = Effect.fn("ExpoRuntime.make")(function* ({ owner, namespace }: ExpoRuntimeOptions) {
    const name = `party-stack:${owner}:${namespace}`;
    const storageName = `party-stack-${yield* Effect.tryPromise({ try: () => hashStorageName(JSON.stringify([owner, namespace])), catch: (cause) => new RuntimeError({ operation: "expoRuntime.name", cause }) })}`;
    const connectivity = yield* Effect.acquireRelease(
        Effect.tryPromise({
            try: () => ExpoNetworkConnectivity.create(),
            catch: (cause) => new RuntimeError({ operation: "expoRuntime.connectivity", cause }),
        }),
        (value) => Effect.sync(() => value.close())
    );
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
    const secrets = makeSecretStore(`${name}:secrets`);
    const ownedTables = yield* tables;
    const encryptionKeyring = yield* makeSecretStoreKeyring(secrets, nativeKeyCodec);
    return yield* Runtime.make({
        owner,
        namespace,
        blobBytes,
        browserAuthentication: createExpoBrowserAuthentication(),
        secrets,
        encryptionKeyring: Effect.succeed(encryptionKeyring),
        connectivity,

        tables: Effect.succeed(ownedTables),
        destroy: async () => {
            await Promise.all([
                deleteDatabaseAsync(`${storageName}-storage.db`).catch((cause) => {
                    if (!Schema.is(Schema.Struct({ code: Schema.Literal("ERR_DATABASE_NOT_FOUND") }))(cause))
                        throw cause;
                }),
                blobBytes.clear(),
            ]);
        },
    });
});
export const layer = (options: ExpoRuntimeOptions) => Layer.effect(Runtime, make(options));
export const createExpoRuntime = (owner: string, namespace: string) => make({ owner, namespace });
