/** Optional in-memory backend. Import explicitly; the main/SQL entry points do not load it. */
import { Effect, Exit, Layer, Semaphore } from "effect";
import { transactionError, type OntologyStorageError } from "../errors.js";
import { queryRows } from "../planner/index.js";
import { makeTables, Tables } from "../tables.js";
import type { DriverTransaction, Entry, Range, StoredIndex, StoredRow } from "../driver/index.js";

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const bucketKey = (table: string, index: string) => JSON.stringify([table, index]);
function position(entries: readonly Entry[], value: string, key: string, exclusive: boolean): number {
    let lo = 0,
        hi = entries.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const entry = entries[mid]!;
        const cmp = compare(entry.value, value) || compare(entry.key, key);
        if (cmp < 0 || (exclusive && cmp === 0)) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}
function window(entries: readonly Entry[], range: Range): [number, number] {
    let start =
        range.lower === undefined
            ? 0
            : position(entries, range.lower, range.lowerOpen ? "\uffff" : "", !!range.lowerOpen);
    let end =
        range.upper === undefined
            ? entries.length
            : position(entries, range.upper, range.upperOpen ? "" : "\uffff", !range.upperOpen);
    if (range.after) {
        if (range.direction === "desc")
            end = Math.min(end, position(entries, range.after.value, range.after.key, false));
        else start = Math.max(start, position(entries, range.after.value, range.after.key, true));
    }
    return [start, Math.max(start, end)];
}
interface State {
    rows: Map<string, Map<string, StoredRow>>;
    definitions: Map<string, Map<string, StoredIndex>>;
    entries: Map<string, Entry[]>;
}
/** Each construction owns an independent database, retained by the service instance. */
export const make = () =>
    Effect.sync(() => {
        let state: State = { rows: new Map(), definitions: new Map(), entries: new Map() };
        const gate = Semaphore.makeUnsafe(1);
        return makeTables({
            transaction: (mode, body) =>
                gate.withPermits(1)(
                    Effect.suspend(() => {
                        const working: State =
                            mode === "readonly"
                                ? state
                                : {
                                      rows: new Map(state.rows),
                                      definitions: new Map(state.definitions),
                                      entries: new Map(state.entries),
                                  };
                        const changedRows = new Set<string>(),
                            changedDefinitions = new Set<string>(),
                            changedEntries = new Set<string>();
                        let active = true;
                        const run = <A>(write: boolean, f: () => A): Effect.Effect<A, OntologyStorageError> =>
                            Effect.suspend(() => {
                                if (!active)
                                    return Effect.fail(transactionError("Closed", "Transaction is closed"));
                                if (write && mode !== "readwrite")
                                    return Effect.fail(transactionError("ReadOnly", "Read-only transaction"));
                                return Effect.sync(f);
                            });
                        const rowsForWrite = (table: string) => {
                            if (!changedRows.has(table)) {
                                working.rows.set(table, new Map(working.rows.get(table)));
                                changedRows.add(table);
                            }
                            return working.rows.get(table)!;
                        };
                        const definitionsForWrite = (table: string) => {
                            if (!changedDefinitions.has(table)) {
                                working.definitions.set(table, new Map(working.definitions.get(table)));
                                changedDefinitions.add(table);
                            }
                            return working.definitions.get(table)!;
                        };
                        const entriesForWrite = (bucket: string) => {
                            if (!changedEntries.has(bucket)) {
                                working.entries.set(bucket, [...(working.entries.get(bucket) ?? [])]);
                                changedEntries.add(bucket);
                            }
                            return working.entries.get(bucket)!;
                        };
                        const raw: DriverTransaction = {
                            query: (table, indexes, query) =>
                                queryRows(raw, table, indexes, query).pipe(
                                    Effect.map((rows) => ({ rows, complete: true }))
                                ),
                            get: (table, key) => run(false, () => working.rows.get(table)?.get(key)),
                            rows: (table) =>
                                run(false, () =>
                                    [...(working.rows.get(table)?.values() ?? [])].sort((a, b) =>
                                        compare(a.key, b.key)
                                    )
                                ),
                            put: (row) =>
                                run(true, () => {
                                    rowsForWrite(row.table).set(row.key, row);
                                }),
                            delete: (table, key) =>
                                run(true, () => {
                                    rowsForWrite(table).delete(key);
                                }),
                            clear: (table) =>
                                run(true, () => {
                                    working.rows.set(table, new Map());
                                    changedRows.add(table);
                                    for (const [bucket, entries] of working.entries)
                                        if (entries[0]?.table === table) {
                                            working.entries.set(bucket, []);
                                            changedEntries.add(bucket);
                                        }
                                }),
                            indexes: (table) =>
                                run(false, () => [...(working.definitions.get(table)?.values() ?? [])]),
                            putIndex: (index) =>
                                run(true, () => {
                                    definitionsForWrite(index.table).set(index.name, index);
                                }),
                            putEntry: (entry) =>
                                run(true, () => {
                                    const entries = entriesForWrite(bucketKey(entry.table, entry.index));
                                    const at = position(entries, entry.value, entry.key, false);
                                    if (entries[at]?.value === entry.value && entries[at]?.key === entry.key)
                                        entries[at] = entry;
                                    else entries.splice(at, 0, entry);
                                }),
                            deleteEntries: (table, index, key) =>
                                run(true, () => {
                                    const bucket = bucketKey(table, index);
                                    working.entries.set(
                                        bucket,
                                        key === undefined
                                            ? []
                                            : (working.entries.get(bucket) ?? []).filter((e) => e.key !== key)
                                    );
                                    changedEntries.add(bucket);
                                }),
                            countEntries: (table, index, range = {}) =>
                                run(false, () => {
                                    const [start, end] = window(
                                        working.entries.get(bucketKey(table, index)) ?? [],
                                        range
                                    );
                                    return end - start;
                                }),
                            entries: (table, index, range = {}) =>
                                run(false, () => {
                                    const source = working.entries.get(bucketKey(table, index)) ?? [];
                                    const [start, end] = window(source, range);
                                    return range.direction === "desc"
                                        ? source
                                              .slice(
                                                  Math.max(start, end - (range.limit ?? source.length)),
                                                  end
                                              )
                                              .reverse()
                                        : source.slice(
                                              start,
                                              Math.min(end, start + (range.limit ?? source.length))
                                          );
                                }),
                        };
                        return Effect.suspend(() => body(raw)).pipe(
                            Effect.onExit((exit) =>
                                Effect.sync(() => {
                                    active = false;
                                    if (Exit.isSuccess(exit) && mode === "readwrite") state = working;
                                })
                            )
                        );
                    })
                ),
        });
    });
export const layer = Layer.effect(Tables, make());
