import { Effect, Stream } from "effect";
import { expect, test } from "vitest";
import { Table } from "../model.js";
import { decodeKey, keyCode, scalarKey } from "../query/evaluate.js";
import { and, eq, field, gt, inArray, or } from "../table-api.js";
import { queryRows } from "./index.js";
import type { DriverTransaction, Entry, Range, StoredIndex } from "../driver/index.js";
import type { Key, Query } from "../model.js";

interface Note {
    readonly id: Key;
    readonly trashed: boolean;
    readonly favorite: boolean | undefined;
    readonly keep: boolean;
    readonly n: number;
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const fixture = (values: readonly Note[]) => {
    const table = Table.make<Note>({ name: "notes" });
    const rows = values.map((value) => ({
        table: table.name,
        key: keyCode(value.id),
        data: table.encode(value),
    }));
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const indexes: readonly StoredIndex[] = ["trashed", "favorite", "n"].map((name) => ({
        table: table.name,
        name,
        version: 1,
        field: field(name),
    }));
    const entries = new Map(
        indexes.map((index) => [
            index.name,
            values
                .map((value): Entry => ({
                    table: table.name,
                    index: index.name,
                    key: keyCode(value.id),
                    value: scalarKey(value[index.name as "trashed" | "favorite" | "n"]),
                }))
                .sort((a, b) => compare(a.value, b.value) || compare(a.key, b.key)),
        ])
    );
    const stats = { entryReads: 0, indexEntries: 0, hydrated: 0, counts: 0 };
    const window = (index: string, range: Range = {}) =>
        entries.get(index)!.filter((entry) => {
            if (
                range.lower !== undefined &&
                (entry.value < range.lower || (range.lowerOpen && entry.value === range.lower))
            )
                return false;
            if (
                range.upper !== undefined &&
                (entry.value > range.upper || (range.upperOpen && entry.value === range.upper))
            )
                return false;
            const after = range.after;
            if (!after) return true;
            const order = compare(entry.value, after.value) || compare(entry.key, after.key);
            return range.direction === "desc" ? order < 0 : order > 0;
        });
    const unused = () => Effect.die("Unexpected write in read-only planner fixture.");
    const raw: DriverTransaction = {
        query: (selected, available, query) => queryRows(raw, selected, available, query),
        get: (_table, key) =>
            Effect.sync(() => {
                stats.hydrated++;
                return byKey.get(key);
            }),
        rows: () => Effect.succeed(rows),
        scanRows: () => Stream.fromIterable(rows),
        indexes: () => Effect.succeed(indexes),
        countEntries: (_table, index, range) =>
            Effect.sync(() => {
                stats.counts++;
                return window(index, range).length;
            }),
        entries: (_table, index, range = {}) =>
            Effect.sync(() => {
                let selected = window(index, range);
                if (range.direction === "desc") selected = selected.reverse();
                selected = selected.slice(0, range.limit);
                stats.entryReads++;
                stats.indexEntries += selected.length;
                return selected;
            }),
        clear: unused,
        put: unused,
        delete: unused,
        putIndex: unused,
        putEntry: unused,
        deleteEntries: unused,
    };
    const read = (query: Query) =>
        queryRows(raw, table, indexes, query).pipe(
            Effect.map((result) =>
                result.decodedRows
                    ? [...result.decodedRows]
                    : result.rows.map((row) => ({ key: decodeKey(row.key), value: table.decode(row.data) }))
            )
        );
    return { read, stats };
};
const notes = (count: number): Note[] =>
    Array.from({ length: count }, (_, n) => ({
        id: `note-${String(n).padStart(5, "0")}`,
        trashed: true,
        favorite: false,
        keep: n % 7 === 0,
        n,
    }));

test("implicit-key delivery pages read equality-index candidates once instead of rescanning every prefix", async () => {
    const values = notes(1436);
    const f = fixture(values);
    await Effect.runPromise(
        Effect.gen(function* () {
            const visited: Key[] = [];
            let after: Query["after"];
            let pages = 0;
            for (;;) {
                const rows = yield* f.read({
                    where: and(eq(field("trashed"), true), eq(field("favorite"), false)),
                    limit: 128,
                    after,
                });
                pages++;
                visited.push(...rows.map((row) => row.key));
                if (rows.length < 128) break;
                after = { key: rows.at(-1)!.key, values: [] };
            }
            const oracle = values
                .filter((value) => value.trashed && !value.favorite)
                .map((value) => value.id)
                .sort((a, b) => compare(keyCode(a), keyCode(b)));
            expect(visited).toEqual(oracle);
            expect(f.stats.hydrated).toBe(values.length);
            expect(f.stats.indexEntries).toBeLessThanOrEqual(values.length + 128);
            expect(f.stats.entryReads).toBeLessThanOrEqual(pages + 1);
        })
    );
});

test("an equality-ordered candidate page still evaluates every residual predicate before offset and limit", async () => {
    const values = notes(900).map((value) => ({
        ...value,
        id: value.n % 2 ? value.n : value.id,
        favorite: value.n % 4 === 0,
    }));
    const f = fixture(values);
    await Effect.runPromise(
        Effect.gen(function* () {
            const cursor = { key: 111, values: [] };
            const rows = yield* f.read({
                where: and(
                    eq(field("trashed"), true),
                    eq(field("favorite"), false),
                    eq(field("keep"), true),
                    gt(field("n"), 130)
                ),
                after: cursor,
                offset: 3,
                limit: 17,
            });
            const oracle = values
                .filter(
                    (value) =>
                        value.trashed &&
                        !value.favorite &&
                        value.keep &&
                        value.n > 130 &&
                        keyCode(value.id) > keyCode(cursor.key)
                )
                .sort((a, b) => compare(keyCode(a.id), keyCode(b.id)))
                .slice(3, 20);
            expect(rows.map((row) => row.value)).toEqual(oracle);
        })
    );
});

test("OR branches and multi-value ranges keep their complete implicit-key order", async () => {
    const values = notes(350).map((value) => ({ ...value, favorite: value.n % 3 === 0 }));
    await Effect.runPromise(
        Effect.gen(function* () {
            for (const where of [
                or(eq(field("favorite"), true), gt(field("n"), 270)),
                inArray(field("n"), [2, 50, 150, 300]),
            ]) {
                const f = fixture(values);
                const actual = yield* f.read({ where, after: { key: "note-00049", values: [] }, limit: 13 });
                const included =
                    where.op === "or"
                        ? (value: Note) => value.favorite || value.n > 270
                        : (value: Note) => [2, 50, 150, 300].includes(value.n);
                const oracle = values
                    .filter((value) => included(value) && String(value.id) > "note-00049")
                    .sort((a, b) => compare(keyCode(a.id), keyCode(b.id)))
                    .slice(0, 13);
                expect(actual.map((row) => row.value)).toEqual(oracle);
            }
        })
    );
});

test("equality groups preserve missing values, absent cursor keys, zero limits and exhausted offsets", async () => {
    const values = notes(350).map((value) => ({
        ...value,
        favorite: value.n % 3 === 0 ? undefined : value.n % 3 === 1,
    }));
    await Effect.runPromise(
        Effect.gen(function* () {
            for (const favorite of [undefined, false, true])
                for (const key of ["note-00000", "note-00111-extra", "note-99999"])
                    for (const offset of [0, 3, 500])
                        for (const limit of [0, 1, 128]) {
                            const f = fixture(values);
                            const actual = yield* f.read({
                                where: eq(field("favorite"), favorite),
                                after: { key, values: [] },
                                offset,
                                limit,
                            });
                            const oracle = values
                                .filter((value) => value.favorite === favorite && String(value.id) > key)
                                .slice(offset, offset + limit);
                            expect(actual.map((row) => row.value)).toEqual(oracle);
                        }
        })
    );
});
