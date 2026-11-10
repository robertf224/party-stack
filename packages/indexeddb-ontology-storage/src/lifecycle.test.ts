import "fake-indexeddb/auto";
import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import { Table, field, where } from "@party-stack/ontology-storage/tables";
import { Effect, Exit } from "effect";
import { expect, test, vi } from "vitest";
import { make } from "./tables.js";

const platform = IndexedDb.make({ indexedDB, IDBKeyRange });
test("Rows, definitions, and versions survive reopening the database", async () => {
    const databaseName = crypto.randomUUID();
    const rows = Table.make<{ n: number }>({ name: "rows" });
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* make({ databaseName });
                yield* tables.put(rows, "key", { n: 3 });
                yield* tables.ensureIndex(rows, { name: "n", field: field("n") });
            })
        ).pipe(Effect.provideService(IndexedDb.IndexedDb, platform))
    );
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* make({ databaseName });
                expect(yield* tables.query(rows, { where: where.eq(field("n"), 3) })).toEqual([
                    { key: "key", value: { n: 3 } },
                ]);
                const changed = Table.make<{ n: number }>({ name: "rows", version: 2 });
                expect(Exit.isFailure(yield* Effect.exit(tables.get(changed, "key")))).toBe(true);
            })
        ).pipe(Effect.provideService(IndexedDb.IndexedDb, platform))
    );
});
test("Scheduler yields do not commit a transaction before a later failure", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* make({ databaseName: crypto.randomUUID() });
                const table = Table.make<number>({ name: "rows" });
                const result = yield* Effect.exit(
                    tables.transaction((tx) =>
                        Effect.gen(function* () {
                            yield* tx.put(table, "row", 1);
                            yield* Effect.yieldNow;
                            yield* Effect.sleep(1);
                            yield* Effect.fail("rollback");
                        })
                    )
                );
                expect(Exit.isFailure(result)).toBe(true);
                expect(yield* tables.get(table, "row")).toBeUndefined();
            })
        ).pipe(Effect.provideService(IndexedDb.IndexedDb, platform))
    );
});
test("An indexed finite ordered query hydrates a bounded page of rows", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* make({ databaseName: crypto.randomUUID() });
                const table = Table.make<{ n: number }>({ name: "rows" });
                yield* tables.transaction((tx) =>
                    Effect.gen(function* () {
                        for (let i = 0; i < 1000; i++) yield* tx.put(table, i, { n: i });
                        yield* tx.ensureIndex(table, { name: "n", field: field("n") });
                    })
                );
                const reads = vi.spyOn(IDBObjectStore.prototype, "get");
                try {
                    expect(
                        (yield* tables.query(table, { orderBy: [{ field: field("n") }], limit: 10 })).length
                    ).toBe(10);
                    // Exclude the transaction-lifetime sentinel requests.
                    expect(
                        reads.mock.calls.filter(([key]) => Array.isArray(key) && key[0] === "rows").length
                    ).toBe(10);
                } finally {
                    reads.mockRestore();
                }
            })
        ).pipe(Effect.provideService(IndexedDb.IndexedDb, platform))
    );
});
