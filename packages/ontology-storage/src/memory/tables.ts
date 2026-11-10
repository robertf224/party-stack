/** Optional in-memory backend. Import explicitly; the main/SQL entry points do not load it. */
import { Effect, Equal, Exit, HashMap, HashSet, Layer, Option, Order, Semaphore, Stream } from "effect";
import { INDEX_BACKFILL_BATCH_SIZE } from "../driver/index.js";
import { transactionError, type OntologyStorageError } from "../errors.js";
import { queryRows } from "../planner/index.js";
import { makeTables, Tables } from "../tables.js";
import * as BTree from "./btree.js";
import type { DriverTransaction, Entry, Range, StoredIndex, StoredRow } from "../driver/index.js";

const entryOrder = Order.make<Entry>((a, b) => Order.String(a.value, b.value) || Order.String(a.key, b.key));
const get = <K, V>(map: HashMap.HashMap<K, V>, key: K): V | undefined =>
    Option.getOrUndefined(HashMap.get(map, key));
// These freshly allocated containers are implementation roots, not user values.
// Structural equality would recursively hash their entire trees on each update.
const setRoot = <K, V extends object>(map: HashMap.HashMap<K, V>, key: K, value: V) =>
    HashMap.set(map, key, Equal.byReferenceUnsafe(value));
interface Rows {
    readonly byKey: HashMap.HashMap<string, StoredRow>;
    readonly keys: BTree.BTree<string>;
}
interface Index {
    readonly sorted: BTree.BTree<Entry>;
    readonly byRow: HashMap.HashMap<string, Memberships>;
}
interface TableIndexes {
    readonly byName: HashMap.HashMap<string, Index>;
}
type Memberships = string | HashSet.HashSet<string>;
const addMembership = (previous: Memberships | undefined, value: string): Memberships =>
    previous === undefined
        ? value
        : typeof previous === "string"
          ? previous === value
              ? previous
              : HashSet.make(previous, value)
          : HashSet.add(previous, value);
interface State {
    rows: HashMap.HashMap<string, Rows>;
    definitions: Map<string, Map<string, StoredIndex>>;
    entries: HashMap.HashMap<string, TableIndexes>;
}
function window(entries: BTree.BTree<Entry>, range: Range): [number, number] {
    let start =
        range.lower === undefined
            ? 0
            : BTree.rank(entries, (entry) => Order.String(entry.value, range.lower!), !!range.lowerOpen);
    let end =
        range.upper === undefined
            ? BTree.size(entries)
            : BTree.rank(entries, (entry) => Order.String(entry.value, range.upper!), !range.upperOpen);
    if (range.after) {
        const after = range.after;
        const compare = (entry: Entry) =>
            Order.String(entry.value, after.value) || Order.String(entry.key, after.key);
        if (range.direction === "desc") end = Math.min(end, BTree.rank(entries, compare));
        else start = Math.max(start, BTree.rank(entries, compare, true));
    }
    return [start, Math.max(start, end)];
}
/** Each construction owns an independent database, retained by the service instance. */
export const make = () =>
    Effect.sync(() => {
        let state: State = { rows: HashMap.empty(), definitions: new Map(), entries: HashMap.empty() };
        const gate = Semaphore.makeUnsafe(1);
        return makeTables({
            transaction: (mode, body) =>
                gate.withPermits(1)(
                    Effect.suspend(() => {
                        // The working roots share immutable paths. Even a one-row edit never
                        // copies a table or sorted index; aborted roots are simply discarded.
                        const working: State = { ...state };
                        const changedDefinitions = new Set<string>();
                        let definitionsCopied = false;
                        let active = true;
                        const run = <A>(write: boolean, f: () => A): Effect.Effect<A, OntologyStorageError> =>
                            Effect.suspend(() => {
                                if (!active)
                                    return Effect.fail(transactionError("Closed", "Transaction is closed"));
                                if (write && mode !== "readwrite")
                                    return Effect.fail(transactionError("ReadOnly", "Read-only transaction"));
                                return Effect.sync(f);
                            });
                        const definitionsForWrite = (table: string) => {
                            if (!definitionsCopied) {
                                working.definitions = new Map(working.definitions);
                                definitionsCopied = true;
                            }
                            if (!changedDefinitions.has(table)) {
                                working.definitions.set(table, new Map(working.definitions.get(table)));
                                changedDefinitions.add(table);
                            }
                            return working.definitions.get(table)!;
                        };
                        const index = (table: string, name: string) => {
                            const indexes = get(working.entries, table);
                            return indexes ? get(indexes.byName, name) : undefined;
                        };
                        const putIndex = (table: string, name: string, value: Index | undefined) => {
                            const indexes =
                                get(working.entries, table)?.byName ?? HashMap.empty<string, Index>();
                            const updated = value
                                ? setRoot(indexes, name, value)
                                : HashMap.remove(indexes, name);
                            working.entries = HashMap.size(updated)
                                ? setRoot(working.entries, table, { byName: updated })
                                : HashMap.remove(working.entries, table);
                        };
                        const raw: DriverTransaction = {
                            query: (table, indexes, query) => queryRows(raw, table, indexes, query),
                            get: (table, key) =>
                                run(false, () => {
                                    const rows = get(working.rows, table);
                                    return rows ? get(rows.byKey, key) : undefined;
                                }),
                            keys: (table, options) =>
                                run(false, () => {
                                    const keys = get(working.rows, table)?.keys;
                                    const start =
                                        options.after === undefined
                                            ? 0
                                            : BTree.rank(
                                                  keys,
                                                  (key) => Order.String(key, options.after!),
                                                  true
                                              );
                                    return BTree.slice(keys, start, BTree.size(keys), false, options.limit);
                                }),
                            rows: (table) =>
                                run(false, () => {
                                    const rows = get(working.rows, table);
                                    return rows
                                        ? Array.from(BTree.values(rows.keys), (key) => get(rows.byKey, key)!)
                                        : [];
                                }),
                            scanRows: (table) =>
                                Stream.unwrap(
                                    run(false, () => {
                                        const rows = get(working.rows, table);
                                        return Stream.fromIterable(rows ? BTree.values(rows.keys) : [], {
                                            chunkSize: INDEX_BACKFILL_BATCH_SIZE,
                                        }).pipe(Stream.map((key) => get(rows!.byKey, key)!));
                                    })
                                ).pipe(Stream.mapEffect((row) => run(false, () => row))),
                            put: (row) =>
                                run(true, () => {
                                    const previous = get(working.rows, row.table);
                                    const byKey = previous?.byKey ?? HashMap.empty<string, StoredRow>();
                                    working.rows = setRoot(working.rows, row.table, {
                                        byKey: HashMap.set(byKey, row.key, row),
                                        keys: HashMap.has(byKey, row.key)
                                            ? previous!.keys
                                            : BTree.set(previous?.keys, row.key, Order.String),
                                    });
                                }),
                            delete: (table, key) =>
                                run(true, () => {
                                    const rows = get(working.rows, table);
                                    if (!rows || !HashMap.has(rows.byKey, key)) return;
                                    const byKey = HashMap.remove(rows.byKey, key);
                                    working.rows = HashMap.size(byKey)
                                        ? setRoot(working.rows, table, {
                                              byKey,
                                              keys: BTree.remove(rows.keys, key, Order.String),
                                          })
                                        : HashMap.remove(working.rows, table);
                                }),
                            clear: (table) =>
                                run(true, () => {
                                    working.rows = HashMap.remove(working.rows, table);
                                    working.entries = HashMap.remove(working.entries, table);
                                }),
                            indexes: (table) =>
                                run(false, () => [...(working.definitions.get(table)?.values() ?? [])]),
                            putIndex: (definition) =>
                                run(true, () => {
                                    definitionsForWrite(definition.table).set(definition.name, definition);
                                }),
                            putEntry: (entry) =>
                                run(true, () => {
                                    const previous = index(entry.table, entry.index);
                                    const byRow = previous?.byRow ?? HashMap.empty<string, Memberships>();
                                    const values = get(byRow, entry.key);
                                    putIndex(entry.table, entry.index, {
                                        sorted: BTree.set(previous?.sorted, entry, entryOrder),
                                        byRow: HashMap.set(
                                            byRow,
                                            entry.key,
                                            addMembership(values, entry.value)
                                        ),
                                    });
                                }),
                            deleteEntries: (table, name, key) =>
                                run(true, () => {
                                    const previous = index(table, name);
                                    if (!previous) return;
                                    if (key === undefined) {
                                        putIndex(table, name, undefined);
                                        return;
                                    }
                                    const values = get(previous.byRow, key);
                                    if (!values) return;
                                    let sorted = previous.sorted;
                                    for (const value of typeof values === "string" ? [values] : values)
                                        sorted = BTree.remove(
                                            sorted,
                                            { table, index: name, value, key },
                                            entryOrder
                                        );
                                    putIndex(
                                        table,
                                        name,
                                        sorted
                                            ? { sorted, byRow: HashMap.remove(previous.byRow, key) }
                                            : undefined
                                    );
                                }),
                            countEntries: (table, name, range = {}) =>
                                run(false, () => {
                                    const [start, end] = window(index(table, name)?.sorted, range);
                                    return end - start;
                                }),
                            entries: (table, name, range = {}) =>
                                run(false, () => {
                                    const sorted = index(table, name)?.sorted;
                                    const [start, end] = window(sorted, range);
                                    return BTree.slice(
                                        sorted,
                                        start,
                                        end,
                                        range.direction === "desc",
                                        range.limit
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
