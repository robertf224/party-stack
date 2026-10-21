import "fake-indexeddb/auto";
import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import { Tables } from "@party-stack/ontology-storage/tables";
import { runContract, runOntologyContract } from "@party-stack/ontology-storage/testing";
import { Effect, Layer } from "effect";
import { test } from "vitest";
import { layer } from "./tables.js";

test("IndexedDB Tables and sparse overlays share the storage contract", async () => {
    const platform = Layer.succeed(IndexedDb.IndexedDb, IndexedDb.make({ indexedDB, IDBKeyRange }));
    const storage = layer({ databaseName: crypto.randomUUID() }).pipe(Layer.provide(platform));
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* Tables;
            yield* runContract(tables);
            yield* runOntologyContract(tables);
        }).pipe(Effect.provide(storage))
    );
});
