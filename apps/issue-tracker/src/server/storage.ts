import { mkdirSync } from "node:fs";
import { makeBetterAuthStorage } from "@party-stack/better-auth/storage";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import * as SQLite from "@party-stack/sql-ontology-storage/sqlite";
import Database from "better-sqlite3";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { serverOntology, authModels } from "./ontology";

const acquirePersistence = Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(
        Effect.sync(() => {
            mkdirSync("temp", { recursive: true });
            return new Database("temp/issue-tracker.sqlite");
        }),
        (database) => Effect.sync(() => database.close())
    );
    const namespace = "issue-tracker-auth-backed";
    const native = yield* SQLite.makeStorage(database, { namespace, mode: "authoritative" });
    const backend = yield* makeOwnedBackend({
        namespace,
        ir: serverOntology,
        ...native,
        mutators: {},
    });
    const adapter = yield* makeBetterAuthStorage({ storage: backend.storage, models: authModels });
    return { adapter, storage: backend.storage, namespace, native };
});
class ServerPersistence extends Context.Service<
    ServerPersistence,
    Effect.Success<typeof acquirePersistence>
>()("issue-tracker/ServerPersistence") {}
const persistence = ManagedRuntime.make(Layer.effect(ServerPersistence, acquirePersistence));
if (import.meta.hot) import.meta.hot.dispose(() => persistence.dispose());
export const serverStorage = await persistence.runPromise(ServerPersistence);
