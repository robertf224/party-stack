import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import { Effect } from "effect";
import { test } from "vitest";
import { checkRequestLifetime, requestPlatform } from "./contracts/requests.js";

test("native request continuations avoid sentinel round trips without early commit", async () => {
    await Effect.runPromise(
        checkRequestLifetime().pipe(Effect.provideService(IndexedDb.IndexedDb, requestPlatform()))
    );
});
