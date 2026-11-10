import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import {
    makeTables,
    INDEX_BACKFILL_BATCH_SIZE,
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
import { Clock, Effect, Exit, Layer, Option, Stream } from "effect";

const stores = ["rows", "definitions", "entries"];
const error = (operation: string, cause: unknown) => storageError("indexeddb", operation, cause);
interface TransactionRequests {
    readonly schedule: (work: () => void, count?: number) => void;
    readonly watch: <A>(request: IDBRequest<A>, success: () => void, failure: () => void) => void;
}
function request<A>(
    make: () => IDBRequest<A>,
    requests: TransactionRequests
): Effect.Effect<A, OntologyStorageError> {
    return Effect.callback((resume) => {
        let cancelled = false;
        requests.schedule(() => {
            if (cancelled) return;
            try {
                const req = make();
                requests.watch(
                    req,
                    () => resume(Effect.succeed(req.result)),
                    () => resume(Effect.fail(error("request", req.error)))
                );
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
    requests: TransactionRequests
): DriverTransaction {
    const run = <A>(make: () => IDBRequest<A>) =>
        isActive()
            ? request(() => {
                  if (!isActive()) throw transactionError("Closed", "Transaction is closed.");
                  return make();
              }, requests)
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
        while (true) {
            const keys = yield* run(() => source.getAllKeys(range, INDEX_BACKFILL_BATCH_SIZE));
            for (const primary of keys) yield* run(() => tx.objectStore("entries").delete(primary));
            if (keys.length < INDEX_BACKFILL_BATCH_SIZE) break;
        }
    });
    const raw: DriverTransaction = {
        query: (table, indexes, query) => queryRows(raw, table, indexes, query),
        clear: Effect.fnUntraced(function* (table: string) {
            const range = keyRange.bound([table], [table, []]);
            yield* run(() => tx.objectStore("entries").delete(range));
            yield* run(() => tx.objectStore("rows").delete(range));
        }),
        get: (table, key) =>
            run(() => tx.objectStore("rows").get([table, key]) as IDBRequest<StoredRow | undefined>),
        keys: (table, options) =>
            run(() =>
                tx
                    .objectStore("rows")
                    .getAllKeys(
                        keyRange.bound(
                            options.after === undefined ? [table] : [table, options.after],
                            [table, []],
                            options.after !== undefined
                        ),
                        options.limit !== undefined && options.limit <= 0xffffffff ? options.limit : undefined
                    )
            ).pipe(Effect.map((keys) => keys.map((key) => (key as [string, string])[1]))),
        rows: (table) =>
            run(() => tx.objectStore("rows").index("table").getAll(table) as IDBRequest<StoredRow[]>),
        scanRows: (table) =>
            Stream.paginate(undefined as string | undefined, (after) =>
                run(
                    () =>
                        tx
                            .objectStore("rows")
                            .getAll(
                                keyRange.bound(
                                    after === undefined ? [table] : [table, after],
                                    [table, []],
                                    after !== undefined
                                ),
                                INDEX_BACKFILL_BATCH_SIZE
                            ) as IDBRequest<StoredRow[]>
                ).pipe(
                    Effect.map(
                        (rows) =>
                            [
                                rows,
                                rows.length === INDEX_BACKFILL_BATCH_SIZE
                                    ? Option.some(rows.at(-1)!.key)
                                    : Option.none<string | undefined>(),
                            ] as const
                    )
                )
            ),
        put: (row) => run(() => tx.objectStore("rows").put(row)).pipe(Effect.asVoid),
        writeRow: (row, remove, put) =>
            Effect.callback<void, OntologyStorageError>((resume) => {
                let cancelled = false;
                requests.schedule(
                    () => {
                        if (cancelled) return;
                        let remaining = remove.length + put.length + 1;
                        const completed = () => {
                            if (--remaining === 0 && !cancelled) resume(Effect.void);
                        };
                        const watch = (request: IDBRequest) =>
                            requests.watch(request, completed, () => {
                                if (!cancelled) resume(Effect.fail(error("writeRow", request.error)));
                            });
                        try {
                            if (!isActive()) throw transactionError("Closed", "Transaction is closed.");
                            const entries = tx.objectStore("entries");
                            // All encoding and uniqueness checks precede this call.
                            // Native request ordering preserves delete-before-put,
                            // including folded keys whose scalar value did not change.
                            for (const entry of remove)
                                watch(entries.delete([entry.table, entry.index, entry.value, entry.key]));
                            for (const entry of put) watch(entries.put(entry));
                            watch(tx.objectStore("rows").put(row));
                        } catch (cause) {
                            resume(
                                Effect.fail(
                                    cause instanceof OntologyStorageError ? cause : error("writeRow", cause)
                                )
                            );
                        }
                    },
                    remove.length + put.length + 1
                );
                return Effect.sync(() => {
                    cancelled = true;
                });
            }),
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
                requests.schedule(() => {
                    if (cancelled) return;
                    try {
                        if (!isActive()) throw transactionError("Closed", "Transaction is closed.");
                        const result: Entry[] = [];
                        const req = tx.objectStore("entries").openCursor(bounds(), "prev");
                        const read = () =>
                            requests.watch(
                                req,
                                () => {
                                    if (cancelled) return;
                                    const cursor = req.result;
                                    if (!cursor) {
                                        resume(Effect.succeed(result));
                                        return;
                                    }
                                    result.push(cursor.value as Entry);
                                    if (range.limit !== undefined && result.length >= range.limit)
                                        resume(Effect.succeed(result));
                                    else {
                                        cursor.continue();
                                        read();
                                    }
                                },
                                () => resume(Effect.fail(error("request", req.error)))
                            );
                        read();
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
            Effect.useSpan("IndexedDB.transaction", { attributes: { operation: mode } }, (span) =>
                Effect.uninterruptibleMask((restore) =>
                    Effect.gen(function* () {
                        const clock = yield* Clock.Clock;
                        let requests = 0;
                        const event = (stage: string) =>
                            span.event("indexeddb.transaction", clock.currentTimeNanosUnsafe(), {
                                diagnostic: true,
                                stage,
                                count: requests,
                            });
                        const tx = yield* Effect.try({
                            try: () => db.transaction(stores, mode),
                            catch: (cause) =>
                                transactionError("Backend", "Cannot start IndexedDB transaction", cause),
                        });
                        let active = true;
                        let pulse = true;
                        let started = false;
                        let inEvent = false;
                        let inFlight = 0;
                        let sentinelPending = false;
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
                        const duringEvent = (work: () => void) => {
                            const previous = inEvent;
                            inEvent = true;
                            try {
                                for (const waiting of pending.splice(0)) waiting();
                                work();
                            } finally {
                                // Real requests keep IDB alive themselves. Only a fiber that
                                // suspended without issuing another request needs a sentinel.
                                keepAlive();
                                inEvent = previous;
                            }
                        };
                        // Keep the transaction alive across Effect scheduler/IO yields.
                        // Normal request continuations issue their next operation directly
                        // inside the active IDB event, without an intervening sentinel read.
                        const keepAlive = () => {
                            if (!pulse || !active || inFlight || sentinelPending) return;
                            sentinelPending = true;
                            const req = tx.objectStore("rows").get(["", ""]);
                            req.onsuccess = () => {
                                sentinelPending = false;
                                duringEvent(() => {
                                    if (!started) {
                                        started = true;
                                        event("active");
                                    }
                                });
                            };
                        };
                        keepAlive();
                        const result = yield* Effect.exit(
                            restore(
                                Effect.suspend(() =>
                                    body(
                                        rawTransaction(tx, platform.IDBKeyRange, () => active, {
                                            schedule: (work, count = 1) => {
                                                requests += count;
                                                if (inEvent) work();
                                                else pending.push(work);
                                            },
                                            watch: (request, success, failure) => {
                                                inFlight++;
                                                request.onsuccess = () => {
                                                    inFlight--;
                                                    duringEvent(success);
                                                };
                                                request.onerror = () => {
                                                    inFlight--;
                                                    // An uncancelled native IDB error aborts the
                                                    // transaction after this callback returns.
                                                    pulse = false;
                                                    duringEvent(failure);
                                                };
                                            },
                                        })
                                    )
                                )
                            )
                        );
                        event("body-complete");
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
                )
            ),
    });
});
/** Supply IndexedDb.layerWindow in browsers, or an injected platform for tests. */
export const layer = (options: { readonly databaseName: string }) => Layer.effect(Tables, make(options));
