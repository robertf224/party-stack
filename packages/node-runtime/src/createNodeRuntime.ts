import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SingleProcessCoordination } from "@party-stack/coordination";
import { storageError } from "@party-stack/ontology-storage/driver";
import { defineRuntime, type RuntimeAdapterProvider } from "@party-stack/runtime";
import * as SQLite from "@party-stack/sql-ontology-storage/sqlite";
import * as SqlTables from "@party-stack/sql-ontology-storage/tables";
import Database from "better-sqlite3";
import { Effect } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { createNodeBrowserAuthentication } from "./createNodeBrowserAuthentication.js";
import { NodeFileSystemBlobBytesStore } from "./NodeFileSystemBlobBytesStore.js";
import { NodeSecretStore } from "./NodeSecretStore.js";

export interface CreateNodeRuntimeOptions {
    dataDirectory?: string;
}

function defaultDataDirectory(): string {
    if (process.platform === "darwin") {
        return join(homedir(), "Library", "Application Support", "party-stack");
    }
    if (process.platform === "win32") {
        return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "party-stack");
    }
    return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "party-stack");
}

function runtimeId(owner: string, namespace: string): string {
    return createHash("sha256")
        .update(JSON.stringify([owner, namespace]))
        .digest("hex");
}

export function createNodeRuntimeWithOptions(options: CreateNodeRuntimeOptions): RuntimeAdapterProvider {
    return defineRuntime(async (owner, namespace) => {
        const scope = `party-stack:${owner}:${namespace}`;
        const directory = join(options.dataDirectory ?? defaultDataDirectory(), runtimeId(owner, namespace));
        await mkdir(directory, {
            recursive: true,
        });

        const tables = Effect.gen(function* () {
            const storageDatabase = yield* Effect.acquireRelease(
                Effect.try({
                    try: () => new Database(join(directory, "storage.sqlite")),
                    catch: (cause) => storageError("sql", "open", cause),
                }),
                (database) => Effect.sync(() => database.close())
            );
            const sql = yield* SQLite.makeClient(storageDatabase).pipe(
                Effect.provide(Reactivity.layer),
                Effect.mapError((cause) => storageError("sql", "open", cause))
            );
            return yield* SqlTables.make().pipe(Effect.provideService(SqlClient.SqlClient, sql));
        });
        const coordination = new SingleProcessCoordination({
            scope,
        });
        const blobBytes = new NodeFileSystemBlobBytesStore({
            directory: join(directory, "blobs"),
        });

        return {
            owner,
            namespace,
            blobBytes,
            browserAuthentication: createNodeBrowserAuthentication(),
            secrets: new NodeSecretStore({
                service: `party-stack:${runtimeId(owner, namespace)}:secrets`,
            }),
            coordination,
            tables,
            cleanup: async () => {
                await coordination.close();
            },
            destroy: () =>
                rm(directory, {
                    recursive: true,
                    force: true,
                }),
        };
    });
}

export const createNodeRuntime = createNodeRuntimeWithOptions({});
