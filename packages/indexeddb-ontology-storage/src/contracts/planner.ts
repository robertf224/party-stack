import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import {
    Table,
    and,
    applyQuery,
    contains,
    eq,
    field,
    gte,
    ilike,
    like,
    or,
    type Query,
} from "@party-stack/ontology-storage/tables";
import { Effect } from "effect";
import { expect, vi } from "vitest";
import { make } from "../tables.js";

/** Run against both fake IndexedDB and a real browser. Count native requests, not planner internals. */
export const checkPlanner = () =>
    Effect.scoped(
        Effect.gen(function* () {
            const tables = yield* make({ databaseName: crypto.randomUUID() });
            const table = Table.make<{ n: number; category: number; name: string; tags?: string[] }>({
                name: "planner_rows",
            });
            const all = Array.from({ length: 1000 }, (_, i) => ({
                key: i,
                value: {
                    n: Math.floor(i / 3),
                    category: i % 100,
                    name: `Prefix-${i}`,
                    tags: i === 42 ? ["urgent", "urgent"] : [],
                },
            }));
            yield* tables.withTransaction(
                Effect.gen(function* () {
                    for (const row of all) yield* tables.put(table, row.key, row.value);
                    for (const name of ["n", "category", "name"])
                        yield* tables.ensureIndex(table, { name, field: field(name) });
                    yield* tables.ensureIndex(table, {
                        name: "tags",
                        field: field("tags"),
                        multiEntry: true,
                    });
                })
            );
            const gets = vi.spyOn(IDBObjectStore.prototype, "get");
            const scans = vi.spyOn(IDBObjectStore.prototype, "getAll");
            const indexScans = vi.spyOn(IDBIndex.prototype, "getAll");
            const counts = vi.spyOn(IDBObjectStore.prototype, "count");
            const cursors = vi.spyOn(IDBObjectStore.prototype, "openCursor");
            const check = (query: Query, rows: number | undefined) =>
                Effect.gen(function* () {
                    gets.mockClear();
                    scans.mockClear();
                    counts.mockClear();
                    indexScans.mockClear();
                    cursors.mockClear();
                    expect(yield* tables.loadSubset(table, query)).toEqual(applyQuery(all, query));
                    const hydrated = gets.mock.calls.filter(
                        ([key]) => Array.isArray(key) && key[0] === table.name
                    ).length;
                    if (rows !== undefined) expect(hydrated).toBe(rows);
                    return hydrated;
                });
            try {
                yield* check({ where: contains(field("tags"), "urgent") }, 1);
                yield* check(
                    { where: or(ilike(field("name"), "prefix-99%"), contains(field("tags"), "urgent")) },
                    12
                );
                yield* check({ where: eq(42, field("category")) }, 10);
                yield* check({ where: and(gte(field("n"), 0), eq(field("category"), -1)) }, 0);
                expect(counts.mock.calls.length).toBe(2);
                expect(
                    scans.mock.contexts.filter((store) => (store as IDBObjectStore).name === "entries")
                ).toHaveLength(0);
                yield* check({ where: and(gte(field("n"), 0), eq(field("category"), 42)) }, 10);
                expect(
                    scans.mock.contexts.filter((store) => (store as IDBObjectStore).name === "entries")
                ).toHaveLength(1);
                yield* check({ where: gte(field("n"), 0) }, 1000);
                expect(
                    scans.mock.calls
                        .filter((_, i) => (scans.mock.contexts[i] as IDBObjectStore).name === "entries")
                        .every(([, limit]) => limit === 128)
                ).toBe(true);
                yield* check(
                    { where: gte(field("n"), 300), orderBy: [{ field: field("n") }], limit: 10 },
                    10
                );
                yield* check(
                    {
                        where: gte(field("n"), 300),
                        orderBy: [{ field: field("n"), direction: "desc" }],
                        limit: 10,
                    },
                    10
                );
                expect(cursors.mock.calls.some(([, direction]) => direction === "prev")).toBe(true);
                yield* check({ where: ilike(field("name"), "pREFIX-99%") }, 11);
                yield* check({ where: like(field("name"), "Prefix-9_9") }, 111);
                yield* check({ where: or(eq(field("category"), 42), eq(field("missing"), undefined)) }, 0);
                expect(
                    indexScans.mock.contexts.some((index) => (index as IDBIndex).objectStore.name === "rows")
                ).toBe(true);
                yield* tables.put(table, 999, { n: 333, category: 99, name: "Renamed" });
                expect(
                    yield* tables.loadSubset(table, { where: ilike(field("name"), "prefix-999") })
                ).toEqual([]);
                yield* tables.delete(table, 990);
                expect(
                    (yield* tables.loadSubset(table, { where: ilike(field("name"), "prefix-99%") })).length
                ).toBe(9);
            } finally {
                gets.mockRestore();
                scans.mockRestore();
                counts.mockRestore();
                indexScans.mockRestore();
                cursors.mockRestore();
            }
        })
    );
export const browserPlatform = () => IndexedDb.make({ indexedDB, IDBKeyRange });
