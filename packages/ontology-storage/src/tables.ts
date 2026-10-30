import { Context, Effect, Schema, Semaphore } from "effect";
import {
    codecError,
    indexError,
    queryError,
    transactionError,
    UniqueConstraint,
    SchemaMismatch,
} from "./errors.js";
import {
    field,
    OntologyStorageError,
    type Index,
    type Key,
    type Query,
    type Row,
    type Table,
    type ReadTable,
} from "./model.js";
import {
    caseInsensitiveIndex,
    applyQuery,
    decodeKey,
    keyCode,
    readField,
    sameField,
    scalarKey,
    validateQuery,
} from "./query/evaluate.js";
import { executeQuery } from "./query/execute.js";
import { IndexSchema } from "./query/schema.js";
import { StoredIndexSchema } from "./storage/schema.js";
import type { Driver, DriverTransaction, Entry, StoredIndex } from "./driver/index.js";
import type { QueryDocument, OntologyIR } from "@party-stack/ontology-spec";

export interface TableQueryOptions {
    readonly sources: Readonly<Record<string, ReadTable<Record<string, unknown>>>>;
    readonly inputs?: Record<string, unknown>;
    readonly context?: Record<string, unknown>;
}
export interface TableQuery {
    (
        document: QueryDocument,
        options: TableQueryOptions
    ): Effect.Effect<Record<string, unknown>, OntologyStorageError>;
    <A>(table: ReadTable<A>, scan?: Query): Effect.Effect<Row<A>[], OntologyStorageError>;
}
const untypedIR: OntologyIR = {
    types: [],
    objectTypes: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
};
export interface ReadTransaction {
    readonly get: <A>(table: Table<A>, key: Key) => Effect.Effect<A | undefined, OntologyStorageError>;
    readonly query: TableQuery;
}
export interface Transaction extends ReadTransaction {
    readonly put: <A>(
        table: Table<A>,
        key: Key,
        value: NoInfer<A>
    ) => Effect.Effect<void, OntologyStorageError>;
    readonly delete: <A>(table: Table<A>, key: Key) => Effect.Effect<void, OntologyStorageError>;
    readonly clear: <A>(table: Table<A>) => Effect.Effect<void, OntologyStorageError>;
    readonly ensureIndex: <A>(table: Table<A>, index: Index) => Effect.Effect<void, OntologyStorageError>;
}
export interface TablesService extends Transaction {
    /** Effect-style transaction combinators. Service operations reuse the contextual transaction. */
    readonly withTransaction: <A, E, R>(
        effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | OntologyStorageError, R>;
    readonly withReadTransaction: <A, E, R>(
        effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | OntologyStorageError, R>;
    readonly transaction: <A, E, R>(
        body: (tx: Transaction) => Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | OntologyStorageError, R>;
    readonly read: <A, E, R>(
        body: (tx: ReadTransaction) => Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | OntologyStorageError, R>;
}
export class Tables extends Context.Service<Tables, TablesService>()(
    "@party-stack/ontology-storage/Tables"
) {}
const attempt = <A>(operation: string, body: () => A): Effect.Effect<A, OntologyStorageError> =>
    Effect.try({ try: body, catch: (cause) => queryError(operation, cause) });
const codec = <A>(direction: "encode" | "decode", body: () => A): Effect.Effect<A, OntologyStorageError> =>
    Effect.try({ try: body, catch: (cause) => codecError(direction, cause) });
function transaction(raw: DriverTransaction, writable: boolean, isOpen: () => boolean): Transaction {
    const gate = Semaphore.makeUnsafe(1);
    const guarded = <A>(effect: Effect.Effect<A, OntologyStorageError>) =>
        gate.withPermits(1)(
            Effect.suspend(() =>
                isOpen() ? effect : Effect.fail(transactionError("Closed", "Transaction is closed."))
            )
        );
    const decodeIndexes = Schema.decodeUnknownSync(Schema.Array(StoredIndexSchema));
    const knownDefinitions = new Map<string, readonly StoredIndex[]>();
    const schemaIndex = "__party_tables_schema__";
    const get = Effect.fnUntraced(function* <A>(table: Table<A>, key: Key) {
        yield* definitions(table);
        const encoded = yield* attempt("key", () => keyCode(key));
        const row = yield* raw.get(table.name, encoded);
        return row ? yield* codec("decode", () => table.decode(row.data)) : undefined;
    });
    const definitions = Effect.fnUntraced(function* <A>(table: ReadTable<A>) {
        const cached = knownDefinitions.get(table.name);
        const stored = cached ?? (yield* raw.indexes(table.name));
        const indexes =
            cached ??
            (yield* Effect.try({
                try: () => decodeIndexes(stored),
                catch: (cause) => indexError("Invalid persisted index metadata", cause),
            }));
        knownDefinitions.set(table.name, indexes);
        if (indexes.some((index) => index.version !== table.version))
            return yield* Effect.fail(
                new OntologyStorageError({
                    operation: "schema",
                    reason: new SchemaMismatch({
                        table: table.name,
                        expected: table.version,
                        actual: indexes.find((i) => i.version !== table.version)!.version,
                        message:
                            "Table version differs from storage. Use a new table namespace or migrate explicitly.",
                    }),
                })
            );
        if (writable && !indexes.some((index) => index.name === schemaIndex)) {
            const stamp: StoredIndex = {
                table: table.name,
                name: schemaIndex,
                field: field(),
                version: table.version,
            };
            yield* raw.putIndex(stamp);
            knownDefinitions.set(table.name, [...indexes, stamp]);
        }
        return indexes.filter((index) => index.name !== schemaIndex);
    });
    const scan = Effect.fnUntraced(function* <A>(table: ReadTable<A>, query: Query = {}) {
        yield* attempt("query", () => validateQuery(query));
        if (query.limit === 0) return [];
        const indexes = yield* definitions(table);
        const result = yield* raw.query(table, indexes, query);
        const decoded = yield* codec("decode", () =>
            result.rows.map((row) => ({ key: decodeKey(row.key), value: table.decode(row.data) }))
        );
        return result.complete ? decoded : yield* attempt("query", () => applyQuery(decoded, query));
    });
    function query(
        document: QueryDocument,
        options: TableQueryOptions
    ): Effect.Effect<Record<string, unknown>, OntologyStorageError>;
    function query<A>(table: ReadTable<A>, scan?: Query): Effect.Effect<Row<A>[], OntologyStorageError>;
    function query<A>(request: QueryDocument | ReadTable<A>, options: TableQueryOptions | Query = {}) {
        if (!("select" in request)) return scan(request, options as Query);
        const bindings = options as TableQueryOptions;
        return Effect.gen(function* () {
            if (!bindings.sources)
                return yield* queryError("query", "Table queries require source bindings.");
            const result = yield* executeQuery(request, {
                inputs: bindings.inputs,
                context: bindings.context,
                error: (failure) => queryError("query", new Error(failure.message, { cause: failure })),
                reader: {
                    ir: untypedIR,
                    untypedSources: new Set(Object.keys(bindings.sources)),
                    loadSubset: (name, query) => {
                        const table = Object.hasOwn(bindings.sources, name)
                            ? bindings.sources[name]
                            : undefined;
                        return table
                            ? scan(table, query)
                            : Effect.fail(queryError("query", `Unknown table source: ${name}`));
                    },
                },
            });
            return result.value;
        });
    }
    const assertWrite = () =>
        writable ? Effect.void : Effect.fail(transactionError("ReadOnly", "Read-only transaction"));
    const deleteRow = Effect.fnUntraced(function* <A>(table: Table<A>, key: Key) {
        yield* assertWrite();
        const code = yield* attempt("key", () => keyCode(key));
        for (const index of yield* definitions(table)) {
            yield* raw.deleteEntries(table.name, index.name, code);
            yield* raw.deleteEntries(table.name, caseInsensitiveIndex(index.name), code);
        }
        yield* raw.delete(table.name, code);
    });
    const makeEntries = Effect.fnUntraced(function* (index: StoredIndex, key: string, value: unknown) {
        const codes = yield* Effect.try({
            try: () => {
                const fieldValue = readField(value, index.field);
                return index.multiEntry
                    ? [...new Set((Array.isArray(fieldValue) ? fieldValue : []).map(scalarKey))]
                    : [scalarKey(fieldValue)];
            },
            catch: (cause) => indexError("Index values must be queryable scalars", cause),
        });
        const entries: Entry[] = [];
        for (const code of codes) {
            if (index.unique) {
                const conflicts = yield* raw.entries(index.table, index.name, { lower: code, upper: code });
                if (conflicts.some((entry) => entry.key !== key))
                    return yield* Effect.fail(
                        new OntologyStorageError({
                            operation: "unique",
                            reason: new UniqueConstraint({
                                table: index.table,
                                index: index.name,
                                message: `Duplicate value for index ${index.name}`,
                            }),
                        })
                    );
            }
            entries.push({
                table: index.table,
                index: index.name,
                key,
                value: code,
                ...(index.multiEntry ? { multiEntry: true } : {}),
            });
        }
        return entries;
    });
    const foldedEntry = (entry: Entry, value: unknown, index: Index): Entry => {
        const scalar = readField(value, index.field);
        return {
            ...entry,
            index: caseInsensitiveIndex(entry.index),
            value: scalarKey(typeof scalar === "string" ? scalar.toLowerCase() : undefined),
        };
    };
    const api: Transaction = {
        get,
        query,
        put: Effect.fnUntraced(function* <A>(table: Table<A>, key: Key, value: A) {
            yield* assertWrite();
            const code = yield* attempt("key", () => keyCode(key));
            const data = yield* codec("encode", () => table.encode(value));
            // Index canonical decoded values, including custom codec transformations.
            const canonical = yield* codec("decode", () => table.decode(data));
            const indexes = yield* definitions(table);
            // Validate every entry before mutating, even when the caller catches
            // a uniqueness/codec error and continues the surrounding transaction.
            const entries: Entry[] = [];
            for (const index of indexes) {
                const indexed = yield* makeEntries(index, code, canonical);
                entries.push(...indexed);
                if (!index.multiEntry) entries.push(foldedEntry(indexed[0]!, canonical, index));
            }
            if (raw.nativeIndexes) {
                yield* raw.put({
                    table: table.name,
                    key: code,
                    data,
                    indexValues: Object.fromEntries([
                        ...entries
                            .filter((entry) => !entry.multiEntry)
                            .map((entry) => [entry.index, entry.value]),
                        ...indexes
                            .filter((index) => index.multiEntry)
                            .map((index) => [
                                index.name,
                                entries
                                    .filter((entry) => entry.index === index.name)
                                    .map((entry) => entry.value),
                            ]),
                    ]),
                });
                return;
            }
            for (const index of indexes) {
                yield* raw.deleteEntries(table.name, index.name, code);
                if (!index.multiEntry)
                    yield* raw.deleteEntries(table.name, caseInsensitiveIndex(index.name), code);
            }
            for (const entry of entries) yield* raw.putEntry(entry);
            yield* raw.put({ table: table.name, key: code, data });
        }),
        delete: deleteRow,
        clear: Effect.fnUntraced(function* <A>(table: Table<A>) {
            yield* assertWrite();
            yield* definitions(table);
            yield* raw.clear(table.name);
        }),
        ensureIndex: Effect.fnUntraced(function* <A>(table: Table<A>, index: Index) {
            yield* assertWrite();
            yield* Effect.try({
                try: () => Schema.decodeUnknownSync(IndexSchema)(index),
                catch: (cause) => indexError("Invalid index definition", cause),
            });
            if (
                !index.name ||
                index.name.startsWith("\0") ||
                index.name === schemaIndex ||
                !index.field.path.length
            )
                return yield* Effect.fail(indexError("Indexes require a name and a nonempty field path"));
            if (index.multiEntry && index.unique)
                return yield* Effect.fail(indexError("Unique array-element indexes are not supported."));
            const existing = (yield* definitions(table)).find((i) => i.name === index.name);
            if (existing) {
                if (
                    !sameField(existing.field, index.field) ||
                    !!existing.unique !== !!index.unique ||
                    !!existing.multiEntry !== !!index.multiEntry
                )
                    return yield* Effect.fail(
                        indexError("Index definition changed; choose a new name or migrate explicitly.")
                    );
                return;
            }
            const definition: StoredIndex = { ...index, table: table.name, version: table.version };
            const entries: Entry[] = [];
            const unique = new Set<string>();
            for (const row of yield* raw.rows(table.name)) {
                const value = yield* codec("decode", () => table.decode(row.data));
                for (const entry of yield* makeEntries({ ...definition, unique: false }, row.key, value)) {
                    if (index.unique && unique.has(entry.value))
                        return yield* Effect.fail(
                            new OntologyStorageError({
                                operation: "unique",
                                reason: new UniqueConstraint({
                                    table: table.name,
                                    index: index.name,
                                    message: `Duplicate value for index ${index.name}`,
                                }),
                            })
                        );
                    unique.add(entry.value);
                    entries.push(entry);
                    if (!index.multiEntry) entries.push(foldedEntry(entry, value, index));
                }
            }
            yield* Effect.all(
                entries.map((entry) => raw.putEntry(entry)),
                { concurrency: 128, discard: true }
            );
            yield* raw.putIndex(definition);
            knownDefinitions.delete(table.name);
        }),
    };
    function guardedQuery(
        document: QueryDocument,
        options: TableQueryOptions
    ): Effect.Effect<Record<string, unknown>, OntologyStorageError>;
    function guardedQuery<A>(
        table: ReadTable<A>,
        scan?: Query
    ): Effect.Effect<Row<A>[], OntologyStorageError>;
    function guardedQuery<A>(request: QueryDocument | ReadTable<A>, options: TableQueryOptions | Query = {}) {
        return "select" in request
            ? guarded(query(request, options as TableQueryOptions))
            : guarded(query(request, options as Query));
    }
    return {
        get: (table, key) => guarded(api.get(table, key)),
        query: guardedQuery,
        put: (table, key, value) => guarded(api.put(table, key, value)),
        delete: (table, key) => guarded(api.delete(table, key)),
        clear: (table) => guarded(api.clear(table)),
        ensureIndex: (table, index) => guarded(api.ensureIndex(table, index)),
    };
}
const CurrentTransactions = Context.Reference<ReadonlyMap<symbol, Transaction>>(
    "@party-stack/ontology-storage/CurrentTransactions",
    { defaultValue: () => new Map() }
);
export function makeTables(driver: Driver): TablesService {
    const identity = Symbol();
    const run = Effect.fnUntraced(function* <A, E, R>(
        mode: "readonly" | "readwrite",
        body: (tx: Transaction) => Effect.Effect<A, E, R>
    ): Effect.fn.Return<A, E | OntologyStorageError, R> {
        const active = yield* CurrentTransactions;
        if (active.has(identity))
            return yield* Effect.fail(
                transactionError(
                    "Nested",
                    "Nested transaction boundaries are unsupported; compose service operations within the current transaction."
                )
            );
        return yield* driver.transaction(mode, (raw) =>
            Effect.suspend(() => {
                let open = true;
                const tx = transaction(raw, mode === "readwrite", () => open);
                return body(tx).pipe(
                    Effect.onExit(() =>
                        Effect.sync(() => {
                            open = false;
                        })
                    ),
                    Effect.provideService(CurrentTransactions, new Map([...active, [identity, tx]]))
                );
            })
        );
    });
    const operation = <A>(
        mode: "readonly" | "readwrite",
        body: (tx: Transaction) => Effect.Effect<A, OntologyStorageError>
    ) =>
        Effect.flatMap(CurrentTransactions, (active) => {
            const tx = active.get(identity);
            return tx ? body(tx) : run(mode, body);
        });
    function query(
        document: QueryDocument,
        options: TableQueryOptions
    ): Effect.Effect<Record<string, unknown>, OntologyStorageError>;
    function query<A>(table: ReadTable<A>, scan?: Query): Effect.Effect<Row<A>[], OntologyStorageError>;
    function query<A>(request: QueryDocument | ReadTable<A>, options: TableQueryOptions | Query = {}) {
        return "select" in request
            ? operation("readonly", (tx) => tx.query(request, options as TableQueryOptions))
            : operation("readonly", (tx) => tx.query(request, options as Query));
    }
    return {
        transaction: (body) => run("readwrite", body),
        read: (body) => run("readonly", body),
        withTransaction: (effect) => run("readwrite", () => effect),
        withReadTransaction: (effect) => run("readonly", () => effect),
        get: (table, key) => operation("readonly", (tx) => tx.get(table, key)),
        query,
        put: (table, key, value) => operation("readwrite", (tx) => tx.put(table, key, value)),
        delete: (table, key) => operation("readwrite", (tx) => tx.delete(table, key)),
        clear: (table) => operation("readwrite", (tx) => tx.clear(table)),
        ensureIndex: (table, index) => operation("readwrite", (tx) => tx.ensureIndex(table, index)),
    };
}
