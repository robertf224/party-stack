import "fake-indexeddb/auto";
import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import { Effect } from "effect";
import { test } from "vitest";
import { requestPlatform } from "./contracts/requests.js";
import { checkUniqueBulkPipeline } from "./contracts/unique-bulk.js";

test("portable unique batches pipeline bounded work without duplicate probes", async () => {
    await Effect.runPromise(
        checkUniqueBulkPipeline().pipe(Effect.provideService(IndexedDb.IndexedDb, requestPlatform()))
    );
});
