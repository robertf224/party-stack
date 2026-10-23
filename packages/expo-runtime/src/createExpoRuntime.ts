import { SingleProcessCoordination } from "@party-stack/coordination";
import { storageError } from "@party-stack/ontology-storage/driver";
import { defineRuntime } from "@party-stack/runtime";
import * as SQLite from "@party-stack/sql-ontology-storage/sqlite";
import * as SqlTables from "@party-stack/sql-ontology-storage/tables";
import { Effect, Schema } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { deleteDatabaseAsync, openDatabaseAsync } from "expo-sqlite";
import { createExpoBrowserAuthentication } from "./createExpoBrowserAuthentication.js";
import { ExpoFileSystemBlobBytesStore } from "./ExpoFileSystemBlobBytesStore.js";
import { ExpoNetworkConnectivity } from "./ExpoNetworkConnectivity.js";
import { ExpoSecretStore } from "./ExpoSecretStore.js";
import { hashStorageName } from "./hashStorageName.js";
import type { RuntimeAdapter } from "@party-stack/runtime";
import type { SQLiteBindValue } from "expo-sqlite";

export interface ExpoRuntimeOptions {
    /** Protect platform secrets with device authentication. Background token refresh may require a prompt.
     * Biometric enrollment changes can invalidate protected secrets. This does not create an unlocked session.
     */
    readonly requireAuthentication?: boolean;
    readonly authenticationPrompt?: string;
}
export const createExpoRuntimeWithOptions = (
    options: ExpoRuntimeOptions = {}
): ((owner: string, namespace: string) => Promise<RuntimeAdapter>) =>
    defineRuntime(async (owner, namespace) => {
        const name = `party-stack:${owner}:${namespace}`;
        const storageName = `party-stack-${await hashStorageName(JSON.stringify([owner, namespace]))}`;
        const connectivity = await ExpoNetworkConnectivity.create();
        const coordination = new SingleProcessCoordination({
            scope: name,
        });
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
        return {
            owner,
            namespace,
            blobBytes,
            browserAuthentication: createExpoBrowserAuthentication(),
            secrets: new ExpoSecretStore(
                `${name}:secrets`,
                Object.keys(options).length ? options : undefined
            ),
            connectivity,
            coordination,
            tables,
            destroy: async () => {
                await Promise.all([
                    deleteDatabaseAsync(`${storageName}.db`),
                    deleteDatabaseAsync(`${storageName}-storage.db`).catch((cause) => {
                        if (
                            !Schema.is(Schema.Struct({ code: Schema.Literal("ERR_DATABASE_NOT_FOUND") }))(
                                cause
                            )
                        )
                            throw cause;
                    }),
                    blobBytes.clear(),
                ]);
            },
            cleanup: async () => {
                await coordination.close();
                connectivity.close();
            },
        };
    });

export const createExpoRuntime = createExpoRuntimeWithOptions();
