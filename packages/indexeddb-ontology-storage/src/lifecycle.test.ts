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
test("Dropping an index removes its definition and exact and folded entries from the stores", async () => {
    const databaseName = crypto.randomUUID();
    const rows = Table.make<{ code: string; region: string }>({ name: "Facility" });
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* make({ databaseName });
                yield* tables.put(rows, "north", { code: "N1", region: "East" });
                yield* tables.ensureIndex(rows, { name: "code", field: field("code"), unique: true });
                yield* tables.ensureIndex(rows, { name: "region", field: field("region") });
                const failed = yield* Effect.exit(
                    tables.transaction((tx) =>
                        Effect.andThen(tx.dropIndex(rows, "code"), Effect.fail("rollback"))
                    )
                );
                expect(Exit.isFailure(failed)).toBe(true);
                expect((yield* tables.indexes(rows)).map((index) => index.name).sort()).toEqual([
                    "code",
                    "region",
                ]);
                yield* tables.dropIndex(rows, "code");
            })
        ).pipe(Effect.provideService(IndexedDb.IndexedDb, platform))
    );
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    try {
        const read = <A>(make: (tx: IDBTransaction) => IDBRequest<A>) =>
            new Promise<A>((resolve, reject) => {
                const request = make(db.transaction(["definitions", "entries"], "readonly"));
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        const entries = (index: string) =>
            read((tx) =>
                tx.objectStore("entries").count(IDBKeyRange.bound([rows.name, index], [rows.name, index, []]))
            );
        const definitions = await read(
            (tx) => tx.objectStore("definitions").getAll() as IDBRequest<{ readonly name: string }[]>
        );
        expect(definitions.map((index) => index.name).sort()).toEqual(["__party_tables_schema__", "region"]);
        expect(await entries("code")).toBe(0);
        expect(await entries("\0code")).toBe(0);
        expect(await entries("region")).toBe(1);
        expect(await entries("\0region")).toBe(1);
    } finally {
        db.close();
    }
});
