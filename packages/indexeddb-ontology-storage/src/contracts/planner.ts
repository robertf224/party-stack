import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import {
    Table,
    and,
    applyQuery,
    contains,
    cursorOf,
    eq,
    field,
    gte,
    inArray,
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
            const table = Table.make<{
                n: number;
                category: number;
                name: string;
                tags?: string[];
                keep?: boolean;
            }>({
                name: "planner_rows",
            });
            const all = Array.from({ length: 1000 }, (_, i) => ({
                key: i,
                value: {
                    n: Math.floor(i / 3),
                    category: i % 100,
                    name: `Prefix-${i}`,
                    tags: i === 42 ? ["urgent", "urgent"] : [],
                    keep: i % 7 === 0,
                },
            }));
            const backfillGets = vi.spyOn(IDBObjectStore.prototype, "getAll");
            try {
                yield* tables.withTransaction(
                    Effect.gen(function* () {
                        for (const row of all) yield* tables.put(table, row.key, row.value);
                        for (const name of ["n", "category", "name", "unpopulated"])
                            yield* tables.ensureIndex(table, { name, field: field(name) });
                        yield* tables.ensureIndex(table, {
                            name: "tags",
                            field: field("tags"),
                            multiEntry: true,
                        });
                    })
                );
                const rowBatches = backfillGets.mock.calls.filter(
                    (_, i) => (backfillGets.mock.contexts[i] as IDBObjectStore).name === "rows"
                );
                expect(rowBatches.length).toBeGreaterThan(1);
                expect(rowBatches.every(([, limit]) => limit === 128)).toBe(true);
            } finally {
                backfillGets.mockRestore();
            }
            const gets = vi.spyOn(IDBObjectStore.prototype, "get");
            const nativeScan = IDBObjectStore.prototype.getAll;
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
                    expect(yield* tables.query(table, query)).toEqual(applyQuery(all, query));
                    const hydrated = gets.mock.calls.filter(
                        ([key]) => Array.isArray(key) && key[0] === table.name
                    ).length;
                    if (rows !== undefined) expect(hydrated).toBe(rows);
                    return hydrated;
                });
            try {
                let active = 0;
                let peak = 0;
                scans.mockImplementation(function (this: IDBObjectStore, ...args) {
                    const request = Reflect.apply(nativeScan, this, args);
                    if (this.name === "entries") {
                        active++;
                        peak = Math.max(peak, active);
                        const finished = () => {
                            active--;
                        };
                        request.addEventListener("success", finished, { once: true });
                        request.addEventListener("error", finished, { once: true });
                    }
                    return request;
                });
                yield* check(
                    { where: inArray(field("category"), [7, ...Array.from({ length: 160 }, (_, i) => i)]) },
                    1000
                );
                expect(peak).toBeGreaterThan(1);
                expect(peak).toBeLessThanOrEqual(128);
                expect(active).toBe(0);
                scans.mockImplementation(nativeScan);
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
                // A discriminating leading sort can read one bounded prefix,
                // without enumerating the predicate and secondary index maps.
                yield* check(
                    {
                        where: gte(field("n"), 0),
                        orderBy: [{ field: field("name"), direction: "desc" }, { field: field("category") }],
                        limit: 17,
                    },
                    128
                );
                expect(
                    scans.mock.contexts.filter((store) => (store as IDBObjectStore).name === "entries")
                ).toHaveLength(0);
                expect(cursors.mock.calls).toHaveLength(2);
                expect(counts.mock.calls).toHaveLength(2);
                // A scalar DESC query restores its implicit ascending key
                // suffix from metadata; small ties need only one leading page.
                yield* check(
                    {
                        orderBy: [{ field: field("category"), direction: "desc", nulls: "first" }],
                        offset: 3,
                        limit: 51,
                    },
                    54
                );
                expect(cursors.mock.calls).toHaveLength(2);
                expect(scans.mock.calls).toHaveLength(0);
                // An incomplete 1000-row tie is scanned by key ASC with a
                // bounded getAll, instead of visiting/hydrating the whole tie.
                yield* check(
                    {
                        orderBy: [{ field: field("unpopulated"), direction: "desc" }],
                        after: { values: [undefined], key: 500 },
                        offset: 3,
                        limit: 51,
                    },
                    54
                );
                expect(cursors.mock.calls).toHaveLength(1);
                expect(scans.mock.calls).toHaveLength(1);
                expect(scans.mock.calls[0]![1]).toBe(54);
                // A delivery scan advances by key, so each matching value
                // should be hydrated once across all pages, not once per page.
                let after: Query["after"];
                let hydrated = 0;
                let visited = 0;
                for (;;) {
                    const query: Query = { where: gte(field("n"), 0), after, limit: 128 };
                    hydrated += yield* check(query, undefined);
                    const page = applyQuery(all, query);
                    visited += page.length;
                    if (page.length < 128) break;
                    after = cursorOf(page.at(-1)!, query);
                }
                expect(visited).toBe(1000);
                expect(hydrated).toBe(1000);
                // A composite-sort traversal must not hydrate the complete
                // candidate set again for every delivery page.
                after = undefined;
                hydrated = 0;
                visited = 0;
                for (;;) {
                    const query: Query = {
                        where: gte(field("n"), 0),
                        orderBy: [
                            { field: field("category"), direction: "desc", nulls: "first" },
                            { field: field("n"), nulls: "first" },
                            { field: field("name"), direction: "desc", nulls: "first" },
                        ],
                        after,
                        limit: 128,
                    };
                    hydrated += yield* check(query, undefined);
                    const page = applyQuery(all, query);
                    visited += page.length;
                    if (page.length < 128) break;
                    after = cursorOf(page.at(-1)!, query);
                }
                expect(visited).toBe(1000);
                expect(hydrated).toBe(1000);
                // The index is only a candidate set: unindexed predicates
                // must still be evaluated before the result limit.
                const residual = yield* check(
                    {
                        where: and(gte(field("n"), 0), eq(field("keep"), true)),
                        after: { key: 501, values: [] },
                        offset: 2,
                        limit: 5,
                    },
                    undefined
                );
                expect(residual).toBeLessThanOrEqual(128);
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
                expect(yield* tables.query(table, { where: ilike(field("name"), "prefix-999") })).toEqual([]);
                yield* tables.delete(table, 990);
                expect(
                    (yield* tables.query(table, { where: ilike(field("name"), "prefix-99%") })).length
                ).toBe(9);
                const puts = vi.spyOn(IDBObjectStore.prototype, "put");
                const deletes = vi.spyOn(IDBObjectStore.prototype, "delete");
                const oldEntries = vi.spyOn(IDBObjectStore.prototype, "getAllKeys");
                try {
                    // A non-indexed field edit must not clear/rebuild every index.
                    yield* tables.put(table, 500, { ...all[500]!.value, keep: true });
                    expect(
                        puts.mock.contexts.filter((store) => (store as IDBObjectStore).name === "entries")
                    ).toHaveLength(0);
                    expect(
                        deletes.mock.contexts.filter((store) => (store as IDBObjectStore).name === "entries")
                    ).toHaveLength(0);
                    expect(oldEntries.mock.calls).toHaveLength(0);
                    // A new key has no old index entries to remove.
                    yield* tables.put(table, 1001, { n: 400, category: 101, name: "New row", tags: ["new"] });
                    expect(oldEntries.mock.calls).toHaveLength(0);
                    expect(yield* tables.query(table, { where: contains(field("tags"), "new") })).toEqual([
                        { key: 1001, value: { n: 400, category: 101, name: "New row", tags: ["new"] } },
                    ]);
                    // Multi-entry order and duplicates do not change membership.
                    puts.mockClear();
                    yield* tables.put(table, 1001, {
                        n: 400,
                        category: 101,
                        name: "New row",
                        tags: ["new", "new"],
                    });
                    expect(
                        puts.mock.contexts.filter((store) => (store as IDBObjectStore).name === "entries")
                    ).toHaveLength(0);
                } finally {
                    puts.mockRestore();
                    deletes.mockRestore();
                    oldEntries.mockRestore();
                }
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
