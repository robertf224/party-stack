import { Effect } from "effect";
import { expect, test } from "vitest";
import { Table } from "../table-api.js";
import { runContract, runBlobContract } from "../testing/index.js";
import { runOntologyContract } from "../testing/ontology.js";
import * as Memory from "./tables.js";

test("Memory Tables passes the same transactional/query/overlay contract", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            yield* runContract(tables);
            yield* runOntologyContract(tables);
            yield* runBlobContract(tables);
        })
    );
});
test("Independent memory services do not share state", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const first = yield* Memory.make(),
                second = yield* Memory.make();
            const rows = Table.make<number>({ name: "rows" });
            yield* first.put(rows, "key", 1);
            expect(yield* first.get(rows, "key")).toBe(1);
            expect(yield* second.get(rows, "key")).toBeUndefined();
        })
    );
});
