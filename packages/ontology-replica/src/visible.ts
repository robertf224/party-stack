import { evaluateQuery } from "@party-stack/ontology-storage";
import { getVisible } from "@party-stack/ontology-storage/overlay";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Stream } from "effect";
import type { BackendError } from "@party-stack/ontology-backend";
import type { Key, Query, Row } from "@party-stack/ontology-storage";
import type { Overlay } from "@party-stack/ontology-storage/overlay";
import type { ReadTransaction, Transaction } from "@party-stack/ontology-storage/tables";

type Value = Record<string, unknown>;
export interface VisibleCommit {
    readonly revision: number;
    readonly previous: number;
    readonly reset: boolean;
    readonly changes: readonly { objectType: string; key: Key; value?: Value }[];
}
export interface ReplicaRowsBatch {
    readonly reset: boolean;
    readonly rows: readonly Row<Value>[];
    readonly removed: readonly Key[];
}
const codec = Table.make<Value>({ name: "visible-row" });

/** Capture before/after composed rows inside the write transaction. A large
 * transaction produces a reset hint instead of an unbounded in-memory event.
 */
export function trackVisible(tx: Transaction, views: ReadonlyMap<string, Overlay<Value>>) {
    const before = new Map<string, { objectType: string; key: Key; encoded: string | undefined }>();
    const tableTypes = new Map<string, string>();
    for (const [type, view] of views)
        for (const table of [view.base, view.inherited, view.overrides])
            if (table) tableTypes.set(table.name, type);
    let reset = false;
    let bytes = 0;
    const touch = Effect.fnUntraced(function* (table: Table<unknown>, key: Key) {
        const objectType = tableTypes.get(table.name);
        if (reset || !objectType) return;
        const id = JSON.stringify([objectType, key]);
        if (before.has(id)) return;
        const value = yield* getVisible(tx, views.get(objectType)!, key);
        const encoded = value === undefined ? undefined : codec.encode(value);
        bytes += new TextEncoder().encode(encoded ?? "").length;
        if (before.size >= 4096 || bytes > 1024 * 1024) {
            reset = true;
            before.clear();
        } else before.set(id, { objectType, key, encoded });
    });
    const wrapped: Transaction = {
        ...tx,
        put: (table, key, value) =>
            touch(table as Table<unknown>, key).pipe(Effect.andThen(tx.put(table, key, value))),
        delete: (table, key) =>
            touch(table as Table<unknown>, key).pipe(Effect.andThen(tx.delete(table, key))),
        clear: (table) =>
            Effect.gen(function* () {
                if (tableTypes.has(table.name) && !reset) {
                    // Only sparse overlays normally use clear. Bound this read as well.
                    const rows = yield* tx.loadSubset(table, { limit: 4097 });
                    if (rows.length > 4096) {
                        reset = true;
                        before.clear();
                    } else for (const row of rows) yield* touch(table as Table<unknown>, row.key);
                }
                yield* tx.clear(table);
            }),
    };
    return {
        tx: wrapped,
        finish: Effect.gen(function* () {
            const changes: VisibleCommit["changes"][number][] = [];
            for (const entry of before.values()) {
                const value = yield* getVisible(tx, views.get(entry.objectType)!, entry.key);
                const encoded = value === undefined ? undefined : codec.encode(value);
                if (encoded !== entry.encoded) {
                    bytes += new TextEncoder().encode(encoded ?? "").length;
                    if (bytes > 1024 * 1024) {
                        reset = true;
                        break;
                    }
                    changes.push({ objectType: entry.objectType, key: entry.key, value });
                }
            }
            return { reset, changes: reset ? [] : changes };
        }),
    };
}

/** Subscribe before the initial read. Lost/coalesced notifications repair from a
 * local snapshot; ordinary unwindowed predicates consume only changed keys.
 */
export function observeRows(options: {
    objectType: string;
    query?: Query;
    changes: Effect.Effect<Stream.Stream<VisibleCommit>, BackendError, import("effect").Scope.Scope>;
    read: (
        body: (
            tx: ReadTransaction
        ) => Effect.Effect<
            { revision: number; rows: readonly Row<Value>[] },
            import("@party-stack/ontology-storage").OntologyStorageError
        >
    ) => Effect.Effect<{ revision: number; rows: readonly Row<Value>[] }, BackendError>;
    snapshot: (
        tx: ReadTransaction
    ) => Effect.Effect<
        { revision: number; rows: readonly Row<Value>[] },
        import("@party-stack/ontology-storage").OntologyStorageError
    >;
}): Stream.Stream<ReplicaRowsBatch, BackendError> {
    return Stream.unwrap(
        Effect.gen(function* () {
            const changes = yield* options.changes;
            const initial = yield* options.read(options.snapshot);
            let revision = initial.revision;
            const query = options.query ?? {};
            const window =
                query.limit !== undefined || query.offset !== undefined || query.after !== undefined;
            return Stream.concat(
                Stream.make({ reset: true, rows: initial.rows, removed: [] }),
                changes.pipe(
                    Stream.mapEffect((commit) =>
                        Effect.gen(function* () {
                            if (commit.revision <= revision) return { reset: false, rows: [], removed: [] };
                            const own = commit.changes.filter((row) => row.objectType === options.objectType);
                            if (commit.reset || commit.previous !== revision || (window && own.length)) {
                                const next = yield* options.read(options.snapshot);
                                revision = next.revision;
                                return { reset: true, rows: next.rows, removed: [] };
                            }
                            revision = commit.revision;
                            const rows = evaluateQuery(
                                own.flatMap((row) =>
                                    row.value === undefined ? [] : [{ key: row.key, value: row.value }]
                                ),
                                query
                            );
                            const matched = new Set(rows.map((row) => row.key));
                            return {
                                reset: false,
                                rows,
                                removed: own.filter((row) => !matched.has(row.key)).map((row) => row.key),
                            };
                        })
                    )
                )
            );
        })
    );
}
