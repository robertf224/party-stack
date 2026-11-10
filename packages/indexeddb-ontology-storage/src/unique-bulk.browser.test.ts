import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import { Effect } from "effect";
import { test } from "vitest";
import { requestPlatform } from "./contracts/requests.js";
import { checkUniqueBulkPipeline } from "./contracts/unique-bulk.js";

test("native IndexedDB unique batches pipeline bounded work and retain rollback", async () => {
    await Effect.runPromise(
        checkUniqueBulkPipeline().pipe(Effect.provideService(IndexedDb.IndexedDb, requestPlatform()))
    );
});
