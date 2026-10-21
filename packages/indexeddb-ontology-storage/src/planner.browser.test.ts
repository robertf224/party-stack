import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import { Effect } from "effect";
import { test } from "vitest";
import { browserPlatform, checkPlanner } from "./contracts/planner.js";

test("Native browser confirms planner read counts and case-insensitive indexes", async () => {
    await Effect.runPromise(
        checkPlanner().pipe(Effect.provideService(IndexedDb.IndexedDb, browserPlatform()))
    );
}, 30000);
