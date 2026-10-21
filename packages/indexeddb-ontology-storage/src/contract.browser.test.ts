import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import { Tables } from "@party-stack/ontology-storage/tables";
import { runBlobContract, runContract, runOntologyContract } from "@party-stack/ontology-storage/testing";
import { Effect, Layer } from "effect";
import { test } from "vitest";
import { layer } from "./tables.js";

test("Native Chromium IndexedDB runs the transactional Tables contract", async () => {
    const storage = layer({ databaseName: crypto.randomUUID() }).pipe(Layer.provide(IndexedDb.layerWindow));
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* Tables;
            yield* runContract(tables);
            yield* runOntologyContract(tables);
            yield* runBlobContract(tables);
        }).pipe(Effect.provide(storage))
    );
}, 30000);
