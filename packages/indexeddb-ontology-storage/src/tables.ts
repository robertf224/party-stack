import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import {
    makeTables,
    storageError,
    transactionError,
    type DriverTransaction,
    type Entry,
    type Range,
    type StoredIndex,
    type StoredRow,
} from "@party-stack/ontology-storage/driver";
import { queryRows } from "@party-stack/ontology-storage/planner";
import { Tables, OntologyStorageError } from "@party-stack/ontology-storage/tables";
import { Effect, Exit, Layer } from "effect";

const stores = ["rows", "definitions", "entries"];
const error = (operation: string, cause: unknown) => storageError("indexeddb", operation, cause);
function request<A>(
    make: () => IDBRequest<A>,
    schedule: (work: () => void) => void
): Effect.Effect<A, OntologyStorageError> {
    return Effect.callback((resume) => {
        let cancelled = false;
        schedule(() => {
            if (cancelled) return;
            try {
                const req = make();
                req.onsuccess = () => resume(Effect.succeed(req.result));
                req.onerror = () => resume(Effect.fail(error("request", req.error)));
            } catch (cause) {
                resume(Effect.fail(cause instanceof OntologyStorageError ? cause : error("request", cause)));
            }
        });
        return Effect.sync(() => {
            cancelled = true;
        });
    });
}
const open = Effect.fnUntraced(function* (factory: IDBFactory, name: string) {
    const req = yield* Effect.try({
        try: () => factory.open(name, 1),
        catch: (cause) => error("open", cause),
    });
    return yield* Effect.callback<IDBDatabase, OntologyStorageError>((resume) => {
        let cancelled = false;
        req.onupgradeneeded = () => {
            const db = req.result;
            db.createObjectStore("rows", { keyPath: ["table", "key"] }).createIndex("table", "table");
            db.createObjectStore("definitions", { keyPath: ["table", "name"] }).createIndex("table", "table");
            const entries = db.createObjectStore("entries", { keyPath: ["table", "index", "value", "key"] });
            entries.createIndex("row", ["table", "index", "key"]);
        };
        req.onsuccess = () => {
            if (cancelled) {
                req.result.close();
                return;
            }
            req.result.onversionchange = () => req.result.close();
            resume(Effect.succeed(req.result));
        };
        req.onerror = () => resume(Effect.fail(error("open", req.error)));
        req.onblocked = () => {
            cancelled = true;
            resume(Effect.fail(error("open", "Database upgrade is blocked by another connection")));
        };
        return Effect.sync(() => {
            cancelled = true;
        });
    });
});
function rawTransaction(
    tx: IDBTransaction,
    keyRange: typeof IDBKeyRange,
    isActive: () => boolean,
    schedule: (work: () => void) => void
): DriverTransaction {
    const run = <A>(make: () => IDBRequest<A>) =>
        isActive()
            ? request(() => {
                  if (!isActive()) throw transactionError("Closed", "Transaction is closed.");
                  return make();
              }, schedule)
            : Effect.fail(transactionError("Closed", "Transaction is closed."));
    const deleteEntries: DriverTransaction["deleteEntries"] = Effect.fnUntraced(function* (
        table: string,
        index: string,
        key?: string
    ) {
        const range =
            key === undefined
                ? keyRange.bound([table, index], [table, index, []])
                : keyRange.only([table, index, key]);
        const source = key === undefined ? tx.objectStore("entries") : tx.objectStore("entries").index("row");
        const keys = yield* run(() => source.getAllKeys(range));
        for (const primary of keys) yield* run(() => tx.objectStore("entries").delete(primary));
    });
    const raw: DriverTransaction = {
        query: (table, indexes, query) =>
            queryRows(raw, table, indexes, query).pipe(Effect.map((rows) => ({ rows, complete: true }))),
        clear: Effect.fnUntraced(function* (table: string) {
            const range = keyRange.bound([table], [table, []]);
            yield* run(() => tx.objectStore("entries").delete(range));
            yield* run(() => tx.objectStore("rows").delete(range));
        }),
        get: (table, key) =>
            run(() => tx.objectStore("rows").get([table, key]) as IDBRequest<StoredRow | undefined>),
        rows: (table) =>
            run(() => tx.objectStore("rows").index("table").getAll(table) as IDBRequest<StoredRow[]>),
        put: (row) => run(() => tx.objectStore("rows").put(row)).pipe(Effect.asVoid),
        delete: (table, key) => run(() => tx.objectStore("rows").delete([table, key])),
        indexes: (table) =>
            run(
                () => tx.objectStore("definitions").index("table").getAll(table) as IDBRequest<StoredIndex[]>
            ),
        putIndex: (index) => run(() => tx.objectStore("definitions").put(index)).pipe(Effect.asVoid),
        putEntry: (entry) => run(() => tx.objectStore("entries").put(entry)).pipe(Effect.asVoid),
        deleteEntries,
        countEntries: (table, index, range: Range = {}) =>
            run(() =>
                tx
                    .objectStore("entries")
                    .count(
                        keyRange.bound(
                            range.lower === undefined
                                ? [table, index]
                                : [table, index, range.lower, ...(range.lowerOpen ? [[]] : [])],
                            range.upper === undefined
                                ? [table, index, []]
                                : [table, index, range.upper, ...(range.upperOpen ? [] : [[]])],
                            !!range.lowerOpen,
                            !!range.upperOpen
                        )
                    )
            ),
        entries: (table, index, range: Range = {}) => {
            const lower =
                range.after && range.direction !== "desc"
                    ? [table, index, range.after.value, range.after.key]
                    : range.lower === undefined
                      ? [table, index]
                      : [table, index, range.lower, ...(range.lowerOpen ? [[]] : [])];
            const upper =
                range.after && range.direction === "desc"
                    ? [table, index, range.after.value, range.after.key]
                    : range.upper === undefined
                      ? [table, index, []]
                      : [table, index, range.upper, ...(range.upperOpen ? [] : [[]])];
            const bounds = () =>
                keyRange.bound(
                    lower,
                    upper,
                    (!!range.after && range.direction !== "desc") || !!range.lowerOpen,
                    (!!range.after && range.direction === "desc") || !!range.upperOpen
                );
            if (range.direction !== "desc")
                return run(
                    () => tx.objectStore("entries").getAll(bounds(), range.limit) as IDBRequest<Entry[]>
                );
            return Effect.callback<readonly Entry[], OntologyStorageError>((resume) => {
                let cancelled = false;
                schedule(() => {
                    if (cancelled) return;
                    try {
                        if (!isActive()) throw transactionError("Closed", "Transaction is closed.");
                        const result: Entry[] = [];
                        const req = tx.objectStore("entries").openCursor(bounds(), "prev");
                        req.onerror = () => resume(Effect.fail(error("request", req.error)));
                        req.onsuccess = () => {
                            if (cancelled) return;
                            const cursor = req.result;
                            if (!cursor) {
                                resume(Effect.succeed(result));
                                return;
                            }
                            result.push(cursor.value as Entry);
                            if (range.limit !== undefined && result.length >= range.limit)
                                resume(Effect.succeed(result));
                            else cursor.continue();
                        };
                    } catch (cause) {
                        resume(
                            Effect.fail(
                                cause instanceof OntologyStorageError ? cause : error("request", cause)
                            )
                        );
                    }
                });
                return Effect.sync(() => {
                    cancelled = true;
                });
            });
        },
    };
    return raw;
}
/** Acquires and closes a database in the caller's Effect scope. */
export const make = Effect.fnUntraced(function* (options: { readonly databaseName: string }) {
    const platform = yield* IndexedDb.IndexedDb;
    const db = yield* Effect.acquireRelease(open(platform.indexedDB, options.databaseName), (db) =>
        Effect.sync(() => db.close())
    );
    return makeTables({
        transaction: (mode, body) =>
            Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                    const tx = yield* Effect.try({
                        try: () => db.transaction(stores, mode),
                        catch: (cause) =>
                            transactionError("Backend", "Cannot start IndexedDB transaction", cause),
                    });
                    let active = true;
                    let pulse = true;
                    const pending: (() => void)[] = [];
                    const done = new Promise<boolean>((resolve) => {
                        tx.oncomplete = () => {
                            active = false;
                            resolve(true);
                        };
                        tx.onabort = () => {
                            active = false;
                            for (const work of pending.splice(0)) work();
                            resolve(false);
                        };
                    });
                    // Keep the transaction alive across Effect's scheduler yields. Without
                    // this, a yielded fiber could resume after IDB had committed its writes.
                    const keepAlive = () => {
                        if (!pulse || !active) return;
                        for (const work of pending.splice(0)) work();
                        if (!pulse || !active) return;
                        const req = tx.objectStore("rows").get(["", ""]);
                        req.onsuccess = keepAlive;
                    };
                    keepAlive();
                    const result = yield* Effect.exit(
                        restore(
                            Effect.suspend(() =>
                                body(
                                    rawTransaction(
                                        tx,
                                        platform.IDBKeyRange,
                                        () => active,
                                        (work) => {
                                            pending.push(work);
                                        }
                                    )
                                )
                            )
                        )
                    );
                    pulse = false;
                    if (Exit.isFailure(result)) {
                        if (active) {
                            // A request failure may already have started aborting.
                            try {
                                tx.abort();
                            } catch {
                                /* onabort still determines completion */
                            }
                        }
                        yield* Effect.promise(() => done);
                        return yield* Effect.failCause(result.cause);
                    }
                    // The final sentinel drains, then IDB commits automatically.
                    // Explicit commit() here could itself run in an inactive task.
                    const committed = yield* Effect.promise(() => done);
                    if (!committed)
                        return yield* Effect.fail(
                            transactionError("Backend", "IndexedDB transaction aborted", tx.error)
                        );
                    return result.value;
                })
            ),
    });
});
/** Supply IndexedDb.layerWindow in browsers, or an injected platform for tests. */
export const layer = (options: { readonly databaseName: string }) => Layer.effect(Tables, make(options));
