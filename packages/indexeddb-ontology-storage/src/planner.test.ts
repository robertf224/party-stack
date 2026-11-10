import "fake-indexeddb/auto";
import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import { Effect } from "effect";
import { test } from "vitest";
import { browserPlatform, checkPlanner } from "./contracts/planner.js";

test("Planner uses estimates, bounded scans, CI indexes, and ordered ranges", async () => {
    await Effect.runPromise(
        checkPlanner().pipe(Effect.provideService(IndexedDb.IndexedDb, browserPlatform()))
    );
}, 30000);
