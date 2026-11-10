import "fake-indexeddb/auto";
import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import { Effect } from "effect";
import { test } from "vitest";
import { checkRequestLifetime, requestPlatform } from "./contracts/requests.js";

test("request continuations avoid sentinel round trips and suspended transactions still roll back", async () => {
    await Effect.runPromise(
        checkRequestLifetime().pipe(Effect.provideService(IndexedDb.IndexedDb, requestPlatform()))
    );
});
