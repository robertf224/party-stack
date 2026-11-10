import { Cause, Context, Effect, Exit, Schema, Semaphore, Stream } from "effect";
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
    type Field,
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
import { FieldSchema, IndexSchema } from "./query/schema.js";
import { StoredIndexSchema } from "./storage/schema.js";
import { CurrentTransactions, provideTransaction, TransactionIdentity } from "./transactionContext.js";
import type { Driver, DriverTransaction, Entry, StoredIndex, StoredRow } from "./driver/index.js";
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
export interface TableKeysOptions {
    /** Exclusive cursor in the table's portable primary-key order. */
    readonly after?: Key;
    readonly limit?: number;
}
export interface ReadTransaction {
    readonly get: <A>(table: Table<A>, key: Key) => Effect.Effect<A | undefined, OntologyStorageError>;
    /** Read keys in input order, omitting missing rows. One consistent
     * transaction read; independent native requests may run in bounded batches.
     */
    readonly getMany: <A>(
        table: Table<A>,
        keys: readonly Key[]
    ) => Effect.Effect<Row<A>[], OntologyStorageError>;
    /** Enumerate primary keys in portable order. Native drivers avoid reading
     * row values; custom drivers may use the ordinary query fallback. The same
     * table version and transaction checks apply as for other reads. */
    readonly keys: <A>(
        table: ReadTable<A>,
        options?: TableKeysOptions
    ) => Effect.Effect<Key[], OntologyStorageError>;
    readonly query: TableQuery;
    /** Optional exact grouped scan for query execution; undefined requests fallback. */
    readonly queryGrouped?: <A>(
        table: ReadTable<A>,
        partition: Field,
        query: Query
    ) => Effect.Effect<Row<A>[] | undefined, OntologyStorageError>;
}
export interface Transaction extends ReadTransaction {
    /** Request write intent before reading to avoid shared-lock upgrade deadlocks. */
    readonly get: <A>(
        table: Table<A>,
        key: Key,
        options?: { readonly forUpdate?: boolean }
    ) => Effect.Effect<A | undefined, OntologyStorageError>;
    /** Insert without replacement; false means a key or unique-index conflict. */
    readonly insert: <A>(
        table: Table<A>,
        key: Key,
        value: NoInfer<A>
    ) => Effect.Effect<boolean, OntologyStorageError>;
    /** Allocate a monotonically increasing publication revision, holding coordination
     * through commit. Call after business writes; callbacks may be retried by SQL.
     * Revisions may have gaps and must not be used as a count of commits. */
    readonly allocateRevision: (
        stream: string,
        minimum?: number
    ) => Effect.Effect<number, OntologyStorageError>;
    readonly put: <A>(
        table: Table<A>,
        key: Key,
        value: NoInfer<A>
    ) => Effect.Effect<void, OntologyStorageError>;
    /** Validate the batch before writing. Independent rows may write concurrently;
     * duplicate keys and dependent unique claims retain sequential write order.
     * All changes belong to the caller's transaction.
     */
    readonly putMany: <A>(
        table: Table<A>,
        rows: readonly Row<NoInfer<A>>[]
    ) => Effect.Effect<void, OntologyStorageError>;
    readonly delete: <A>(table: Table<A>, key: Key) => Effect.Effect<void, OntologyStorageError>;
    readonly clear: <A>(table: Table<A>) => Effect.Effect<void, OntologyStorageError>;
    readonly ensureIndex: <A>(table: Table<A>, index: Index) => Effect.Effect<void, OntologyStorageError>;
}
export interface TablesService extends Transaction {
    readonly [TransactionIdentity]?: symbol;
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
// Only explicitly classified storage failures cross the typed error boundary.
// Unexpected throws from caller-owned row access retain defect semantics.
class PreparationFailure {
    constructor(readonly error: OntologyStorageError) {}
}
const preparation = <A>(body: () => A): Effect.Effect<A, OntologyStorageError> =>
    Effect.suspend(() => {
        try {
            return Effect.succeed(body());
        } catch (cause) {
            return cause instanceof PreparationFailure ? Effect.fail(cause.error) : Effect.die(cause);
        }
    });
// Pure preparation retains the same tagged failure at each storage boundary.
// Bulk callers run this work in bounded synchronous units; single writes reuse it.
const prepareValue = <A>(table: Table<A>, key: Key, value: A) => {
    let code: string;
    let data: string;
    let canonical: A;
    try {
        code = keyCode(key);
    } catch (cause) {
        throw new PreparationFailure(queryError("key", cause));
    }
    try {
        data = table.encode(value);
    } catch (cause) {
        throw new PreparationFailure(codecError("encode", cause));
    }
    try {
        canonical = table.decode(data);
    } catch (cause) {
        throw new PreparationFailure(codecError("decode", cause));
    }
    return { code, data, canonical };
};
const indexCodes = (index: StoredIndex, value: unknown) => {
    const fieldValue = readField(value, index.field);
    return index.multiEntry
        ? [...new Set((Array.isArray(fieldValue) ? fieldValue : []).map(scalarKey))]
        : [scalarKey(fieldValue)];
};
const prepareIndexPlan = <A>(value: ReturnType<typeof prepareValue<A>>, indexes: readonly StoredIndex[]) => {
    try {
        return {
            code: value.code,
            data: value.data,
            canonical: value.canonical,
            indexes,
            codes: indexes.map((index) => indexCodes(index, value.canonical)),
        };
    } catch (cause) {
        throw new PreparationFailure(indexError("Index values must be queryable scalars", cause));
    }
};
const previousValue = <A>(table: Table<A>, previous: StoredRow | undefined): A | undefined => {
    if (!previous) return undefined;
    try {
        return table.decode(previous.data);
    } catch (cause) {
        throw new PreparationFailure(codecError("decode", cause));
    }
};
const indexDifference = (
    index: StoredIndex,
    codes: readonly string[],
    previous: unknown,
    hasPrevious: boolean
) => {
    let previousCodes: string[] | undefined;
    if (hasPrevious) {
        try {
            previousCodes = indexCodes(index, previous);
        } catch (cause) {
            throw new PreparationFailure(indexError("Index values must be queryable scalars", cause));
        }
    }
    const prior = previousCodes;
    const unchanged = prior && codes.length === prior.length && codes.every((value) => prior.includes(value));
    return { codes, previousCodes, unchanged };
};
const indexEntry = (index: StoredIndex, key: string, value: string): Entry => ({
    table: index.table,
    index: index.name,
    key,
    value,
    ...(index.multiEntry ? { multiEntry: true } : {}),
});
interface EntryChanges {
    readonly entries: Entry[];
    readonly removedEntries: Entry[];
    readonly changedIndexes: StoredIndex[];
}
const bulkSpan = <A, E, R>(
    enabled: boolean,
    name: string,
    effect: Effect.Effect<A, E, R>,
    attributes: Record<string, string | number | boolean> = {}
) => (enabled ? effect.pipe(Effect.withSpan(name, { attributes })) : effect);
const bulkAttributes = (enabled: boolean, attributes: Record<string, string | number | boolean>) =>
    enabled ? Effect.annotateCurrentSpan(attributes) : Effect.void;
function transaction(
    raw: DriverTransaction,
    writable: boolean,
    isOpen: () => boolean,
    identity: symbol
): Transaction {
    const gate = Semaphore.makeUnsafe(1);
    const guarded = <A>(effect: Effect.Effect<A, OntologyStorageError>) =>
        gate.withPermits(1)(
            Effect.suspend(() =>
                isOpen() ? effect : Effect.fail(transactionError("Closed", "Transaction is closed."))
            )
        );
    const decodeIndexes = Schema.decodeUnknownSync(Schema.Array(StoredIndexSchema));
    const decodeField = Schema.decodeUnknownSync(FieldSchema);
    const knownDefinitions = new Map<string, readonly StoredIndex[]>();
    const schemaIndex = "__party_tables_schema__";
    const get = Effect.fnUntraced(function* <A>(
        table: Table<A>,
        key: Key,
        options?: { readonly forUpdate?: boolean }
    ) {
        if (options?.forUpdate) yield* assertWrite();
        yield* definitions(table);
        const encoded = yield* attempt("key", () => keyCode(key));
        const row = yield* raw.get(table.name, encoded, options?.forUpdate);
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
    const getMany = Effect.fnUntraced(function* <A>(table: Table<A>, keys: readonly Key[]) {
        if (!keys.length) return [];
        const codes = yield* attempt("key", () => keys.map(keyCode));
        yield* definitions(table);
        const rows = yield* Effect.forEach(codes, (code) => raw.get(table.name, code), { concurrency: 128 });
        return yield* codec("decode", () =>
            rows.flatMap((row, i) => (row ? [{ key: keys[i]!, value: table.decode(row.data) }] : []))
        );
    });
    const scan = Effect.fnUntraced(function* <A>(table: ReadTable<A>, query: Query = {}) {
        yield* attempt("query", () => validateQuery(query));
        if (query.limit === 0) return [];
        const indexes = yield* definitions(table);
        const result = yield* raw.query(table, indexes, query);
        const decoded = result.decodedRows
            ? [...result.decodedRows]
            : yield* codec("decode", () =>
                  result.rows.map((row) => ({ key: decodeKey(row.key), value: table.decode(row.data) }))
              );
        return result.complete ? decoded : yield* attempt("query", () => applyQuery(decoded, query));
    });
    const keys = Effect.fnUntraced(function* <A>(table: ReadTable<A>, options: TableKeysOptions = {}) {
        const query: Query = {
            after: options.after === undefined ? undefined : { key: options.after, values: [] },
            limit: options.limit,
        };
        yield* attempt("query", () => validateQuery(query));
        if (options.limit === 0) return [];
        if (!raw.keys) return (yield* scan(table, query)).map((row) => row.key);
        yield* definitions(table);
        const encoded = yield* raw.keys(table.name, {
            after: options.after === undefined ? undefined : keyCode(options.after),
            limit: options.limit,
        });
        return yield* attempt("key", () => encoded.map(decodeKey));
    });
    const scanGrouped = Effect.fnUntraced(function* <A>(table: ReadTable<A>, partition: Field, query: Query) {
        yield* attempt("query", () => {
            validateQuery(query);
            decodeField(partition);
        });
        const indexes = yield* definitions(table);
        if (query.limit === 0) return [];
        const result = yield* raw.queryGrouped!(table, indexes, partition, query);
        return result === undefined
            ? undefined
            : yield* codec("decode", () =>
                  result.map((row) => ({ key: decodeKey(row.key), value: table.decode(row.data) }))
              );
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
                    ...(raw.queryGrouped
                        ? {
                              loadGroupedSubset: (name: string, partition: Field, query: Query) => {
                                  const table = Object.hasOwn(bindings.sources, name)
                                      ? bindings.sources[name]
                                      : undefined;
                                  return table
                                      ? scanGrouped(table, partition, query)
                                      : Effect.fail(queryError("query", `Unknown table source: ${name}`));
                              },
                          }
                        : {}),
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
        const indexes = yield* definitions(table);
        if (!raw.nativeIndexes)
            for (const index of indexes) {
                yield* raw.deleteEntries(table.name, index.name, code);
                yield* raw.deleteEntries(table.name, caseInsensitiveIndex(index.name), code);
            }
        yield* raw.delete(table.name, code);
    });
    const entryCodes = (index: StoredIndex, value: unknown) =>
        Effect.try({
            try: () => indexCodes(index, value),
            catch: (cause) => indexError("Index values must be queryable scalars", cause),
        });
    const makeEntries = Effect.fnUntraced(function* (
        index: StoredIndex,
        key: string,
        value: unknown,
        providedCodes?: readonly string[]
    ) {
        const codes = providedCodes ?? (yield* entryCodes(index, value));
        const entries: Entry[] = [];
        for (const code of codes) {
            if (index.unique) {
                const conflicts = yield* raw.entries(index.table, index.name, {
                    lower: code,
                    upper: code,
                    limit: 2,
                });
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
            entries.push(indexEntry(index, key, code));
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
    const prepareWrite = Effect.fnUntraced(function* <A>(table: Table<A>, key: Key, value: A) {
        yield* assertWrite();
        // Preserve key/codec validation before the first definition check.
        const prepared = yield* preparation(() => prepareValue(table, key, value));
        const indexes = yield* definitions(table);
        return yield* preparation(() => prepareIndexPlan(prepared, indexes));
    });
    const prepareBatch = Effect.fnUntraced(function* <A>(table: Table<A>, rows: readonly Row<A>[]) {
        if (!rows.length) return [];
        const first = yield* prepareWrite(table, rows[0]!.key, rows[0]!.value);
        const plans = [first];
        for (let offset = 1; offset < rows.length; offset += 128) {
            const end = Math.min(offset + 128, rows.length);
            yield* preparation(() => {
                for (let index = offset; index < end; index++) {
                    const row = rows[index]!;
                    plans.push(prepareIndexPlan(prepareValue(table, row.key, row.value), first.indexes));
                }
            });
            if (end < rows.length) yield* Effect.yieldNow;
        }
        return plans;
    });
    type PreparedWrite<A> = Effect.Success<ReturnType<typeof prepareWrite<A>>>;
    // Shared pure append keeps portable-index changes identical in both paths.
    // The normal path performs unique probes before reaching this stage.
    const appendEntryChanges = <A>(
        result: EntryChanges,
        table: Table<A>,
        index: StoredIndex,
        plan: PreparedWrite<A>,
        previous: StoredRow | undefined,
        before: A | undefined,
        difference: ReturnType<typeof indexDifference>,
        indexed: readonly Entry[]
    ) => {
        if (difference.unchanged && !raw.nativeIndexes) return;
        result.changedIndexes.push(index);
        if (raw.writeRow && previous && !raw.nativeIndexes)
            for (const value of difference.previousCodes!) {
                const entry = { table: table.name, index: index.name, key: plan.code, value };
                result.removedEntries.push(entry);
                if (!index.multiEntry) result.removedEntries.push(foldedEntry(entry, before, index));
            }
        result.entries.push(...indexed);
        // Only positive string-prefix ILIKE plans read this hidden index.
        // Non-strings never match; indexing an undefined placeholder for each
        // boolean/date/number doubles writes without supplying query candidates.
        // Keep legacy placeholder removal above when replacing an older row.
        // Native SQL projections still need the placeholder: SQL NULL would
        // change negated text predicates through three-valued logic.
        if (
            !index.multiEntry &&
            (raw.nativeIndexes || typeof readField(plan.canonical, index.field) === "string")
        )
            result.entries.push(foldedEntry(indexed[0]!, plan.canonical, index));
    };
    const prepareEntries = Effect.fnUntraced(function* <A>(
        table: Table<A>,
        plan: PreparedWrite<A>,
        previous: StoredRow | undefined,
        nativeInsert = false,
        nativeNew = false
    ) {
        const { code, canonical, indexes } = plan;
        const before = previous ? yield* preparation(() => previousValue(table, previous)) : undefined;
        const result: EntryChanges = { entries: [], removedEntries: [], changedIndexes: [] };
        for (const [i, index] of indexes.entries()) {
            const difference = previous
                ? yield* preparation(() => indexDifference(index, plan.codes[i]!, before, true))
                : indexDifference(index, plan.codes[i]!, undefined, false);
            // Keep IO before folded-entry construction: a unique conflict must
            // precede a later index/codec failure just as in ordinary put.
            const indexed = yield* makeEntries(
                difference.unchanged || nativeInsert || nativeNew ? { ...index, unique: false } : index,
                code,
                canonical,
                difference.codes
            );
            appendEntryChanges(result, table, index, plan, previous, before, difference, indexed);
        }
        return result;
    });
    // Bulk ownership probes happen separately. This stage performs no IO, while
    // sharing old-value decoding, index differences and append rules above.
    const prepareValidatedEntries = <A>(
        table: Table<A>,
        plan: PreparedWrite<A>,
        previous: StoredRow | undefined
    ): EntryChanges => {
        const before = previousValue(table, previous);
        const result: EntryChanges = { entries: [], removedEntries: [], changedIndexes: [] };
        for (const [i, index] of plan.indexes.entries()) {
            const difference = indexDifference(index, plan.codes[i]!, before, previous !== undefined);
            if (difference.unchanged && !raw.nativeIndexes) continue;
            const indexed = difference.codes.map((code) => indexEntry(index, plan.code, code));
            appendEntryChanges(result, table, index, plan, previous, before, difference, indexed);
        }
        return result;
    };
    type EntryPlan = Effect.Success<ReturnType<typeof prepareEntries>>;
    const writePortable = Effect.fnUntraced(function* <A>(
        table: Table<A>,
        plan: PreparedWrite<A>,
        previous: boolean,
        prepared: EntryPlan
    ) {
        const { code, data } = plan;
        const { entries, removedEntries, changedIndexes } = prepared;
        if (raw.writeRow) {
            yield* raw.writeRow({ table: table.name, key: code, data }, removedEntries, entries);
            return true;
        }
        if (previous)
            for (const index of changedIndexes) {
                yield* raw.deleteEntries(table.name, index.name, code);
                if (!index.multiEntry)
                    yield* raw.deleteEntries(table.name, caseInsensitiveIndex(index.name), code);
            }
        for (const entry of entries) yield* raw.putEntry(entry);
        yield* raw.put({ table: table.name, key: code, data });
        return true;
    });
    const writeRow = Effect.fnUntraced(function* <A>(
        table: Table<A>,
        key: Key,
        value: A,
        insertOnly: boolean,
        prepared?: PreparedWrite<A>
    ) {
        const plan = prepared ?? (yield* prepareWrite(table, key, value));
        const { code, data, canonical, indexes } = plan;
        if (insertOnly && !raw.insert && (yield* raw.get(table.name, code))) return false;
        // Validate every entry before mutating, even when the caller catches
        // a uniqueness/codec error and continues the surrounding transaction.
        const nativeInsert = insertOnly && raw.insert && raw.nativeIndexes;
        const previous =
            !insertOnly &&
            ((!raw.nativeIndexes && indexes.length > 0) || indexes.some((index) => index.unique))
                ? yield* raw.get(table.name, code)
                : undefined;
        const nativeNew =
            !insertOnly &&
            !previous &&
            raw.insert &&
            raw.nativeIndexes &&
            indexes.some((index) => index.unique);
        const preparedEntries = yield* prepareEntries(table, plan, previous, !!nativeInsert, !!nativeNew);
        const { entries } = preparedEntries;
        if (raw.nativeIndexes) {
            const row: StoredRow = {
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
                            entries.filter((entry) => entry.index === index.name).map((entry) => entry.value),
                        ]),
                ]),
            };
            if (insertOnly && raw.insert) return yield* raw.insert(row);
            if (nativeNew && raw.insert) {
                if (yield* raw.insert(row)) return true;
                // A real conflict needs the portable diagnostic. The failed
                // native insert changed nothing and did not abort the transaction.
                for (const index of indexes) if (index.unique) yield* makeEntries(index, code, canonical);
            }
            yield* raw.put(row);
            return true;
        }
        return yield* writePortable(table, plan, !!previous, preparedEntries);
    });
    const independentUniqueBatch = Effect.fnUntraced(function* <A>(
        table: Table<A>,
        plans: readonly PreparedWrite<A>[],
        diagnostic: boolean
    ) {
        // The public operation holds this transaction's gate throughout. A
        // disjoint incoming slot with no foreign owner remains safe until write.
        const owners = new Map<string, string>();
        for (const plan of plans)
            for (const [i, index] of plan.indexes.entries()) {
                if (!index.unique) continue;
                for (const code of plan.codes[i]!) {
                    const slot = JSON.stringify([index.name, code]);
                    const owner = owners.get(slot);
                    if (owner !== undefined && owner !== plan.code) {
                        yield* bulkAttributes(diagnostic, {
                            reason: "duplicate-slots",
                            uniqueSlots: owners.size,
                        });
                        return;
                    }
                    owners.set(slot, plan.code);
                }
            }
        yield* bulkAttributes(diagnostic, { uniqueSlots: owners.size });
        const prefetched = yield* Effect.exit(
            bulkSpan(
                diagnostic,
                "Tables.putMany.proof.previous",
                Effect.forEach(plans, (plan) => raw.get(table.name, plan.code), { concurrency: 128 })
            )
        );
        if (Exit.isFailure(prefetched)) {
            if (Cause.hasInterrupts(prefetched.cause)) return yield* Effect.failCause(prefetched.cause);
            yield* bulkAttributes(diagnostic, { reason: "previous-read-failure" });
            return;
        }
        const previous = prefetched.value;
        const prepared = yield* bulkSpan(
            diagnostic,
            "Tables.putMany.proof.entries",
            Effect.gen(function* () {
                const result: EntryPlan[] = [];
                for (let offset = 0; offset < plans.length; offset += 128) {
                    const end = Math.min(offset + 128, plans.length);
                    const page = yield* Effect.exit(
                        preparation(() => {
                            for (let i = offset; i < end; i++)
                                result.push(prepareValidatedEntries(table, plans[i]!, previous[i]));
                        })
                    );
                    if (Exit.isFailure(page)) {
                        if (Cause.hasInterrupts(page.cause)) return yield* Effect.failCause(page.cause);
                        return;
                    }
                    if (end < plans.length) yield* Effect.yieldNow;
                }
                return result;
            })
        );
        if (!prepared) {
            yield* bulkAttributes(diagnostic, { reason: "previous-entry-failure" });
            return;
        }
        const probes = prepared.flatMap((entryPlan, i) =>
            entryPlan.changedIndexes.flatMap((index) => {
                if (!index.unique) return [];
                const plan = plans[i]!;
                return plan.codes[plan.indexes.indexOf(index)]!.map((code) => ({
                    table: index.table,
                    index: index.name,
                    key: plan.code,
                    value: code,
                }));
            })
        );
        yield* bulkAttributes(diagnostic, { uniqueProbes: probes.length });
        const checked = yield* Effect.exit(
            bulkSpan(
                diagnostic,
                "Tables.putMany.proof.owners",
                Effect.forEach(
                    probes,
                    (entry) =>
                        Effect.map(
                            raw.entries(entry.table, entry.index, {
                                lower: entry.value,
                                upper: entry.value,
                                limit: 2,
                            }),
                            (existing) => existing.some((owner) => owner.key !== entry.key)
                        ),
                    { concurrency: 128 }
                )
            )
        );
        if (Exit.isFailure(checked)) {
            if (Cause.hasInterrupts(checked.cause)) return yield* Effect.failCause(checked.cause);
            yield* bulkAttributes(diagnostic, { reason: "owner-read-failure" });
            return;
        }
        if (checked.value.some(Boolean)) {
            yield* bulkAttributes(diagnostic, { reason: "foreign-owner" });
            return;
        }
        yield* bulkAttributes(diagnostic, { reason: "independent" });
        return prepared.map((entryPlan, i) => ({ entries: entryPlan, previous: !!previous[i] }));
    });
    const api: Transaction = {
        allocateRevision: Effect.fnUntraced(function* (stream: string, minimum = 0) {
            yield* assertWrite();
            if (!stream || !Number.isSafeInteger(minimum) || minimum < 0)
                return yield* queryError(
                    "revision",
                    "Revision streams require a name and nonnegative safe minimum."
                );
            if (raw.allocateRevision) return yield* raw.allocateRevision(stream, minimum);
            // Serialized drivers keep their clock in the same physical transaction.
            const table = "\0party:revisions";
            const key = keyCode(stream);
            const previous = yield* raw.get(table, key);
            const revision = Math.max(previous ? Number(previous.data) : 0, minimum) + 1;
            if (!Number.isSafeInteger(revision))
                return yield* transactionError("Backend", "Publication revision exhausted.");
            yield* raw.put({ table, key, data: String(revision) });
            return revision;
        }),
        get,
        getMany,
        keys,
        query,
        put: (table, key, value) => Effect.asVoid(writeRow(table, key, value, false)),
        putMany: <A>(table: Table<A>, rows: readonly Row<A>[]) => {
            // Bounded phase diagnostics: no row identifiers, table names or values.
            const diagnostic = rows.length >= 64;
            return bulkSpan(
                diagnostic,
                "Tables.putMany",
                Effect.gen(function* () {
                    yield* assertWrite();
                    const plans = yield* bulkSpan(
                        diagnostic,
                        "Tables.putMany.prepare",
                        prepareBatch(table, rows)
                    );
                    const independentKeys =
                        !raw.nativeIndexes && new Set(plans.map((plan) => plan.code)).size === plans.length;
                    const unique = plans[0]?.indexes.some((index) => index.unique);
                    const prepared =
                        independentKeys && unique
                            ? yield* bulkSpan(
                                  diagnostic,
                                  "Tables.putMany.proof",
                                  independentUniqueBatch(table, plans, diagnostic)
                              )
                            : undefined;
                    const concurrency = prepared || (independentKeys && !unique) ? 128 : 1;
                    yield* bulkAttributes(diagnostic, {
                        indexes: plans[0]?.indexes.length ?? 0,
                        concurrency,
                        state: prepared
                            ? "independent-unique"
                            : independentKeys && !unique
                              ? "independent"
                              : "sequential",
                        ...(!independentKeys || !unique
                            ? {
                                  reason: raw.nativeIndexes
                                      ? "native-indexes"
                                      : !independentKeys
                                        ? "duplicate-keys"
                                        : "no-unique-index",
                              }
                            : {}),
                    });
                    let activeWrites = 0;
                    let peakWrites = 0;
                    const writes = Effect.forEach(
                        plans,
                        (plan, i) => {
                            const write = prepared
                                ? writePortable(table, plan, prepared[i]!.previous, prepared[i]!.entries)
                                : writeRow(table, rows[i]!.key, rows[i]!.value, false, plan);
                            return !diagnostic
                                ? write
                                : Effect.suspend(() => {
                                      activeWrites++;
                                      peakWrites = Math.max(peakWrites, activeWrites);
                                      return write.pipe(
                                          Effect.ensuring(
                                              Effect.sync(() => {
                                                  activeWrites--;
                                              })
                                          )
                                      );
                                  });
                        },
                        { concurrency, discard: true }
                    );
                    yield* bulkSpan(
                        diagnostic,
                        "Tables.putMany.write",
                        diagnostic
                            ? writes.pipe(Effect.onExit(() => Effect.annotateCurrentSpan({ peakWrites })))
                            : writes,
                        { concurrency }
                    );
                }),
                { rows: rows.length }
            );
        },
        insert: (table, key, value) =>
            writeRow(table, key, value, true).pipe(
                Effect.catchReason("OntologyStorageError", "UniqueConstraint", () => Effect.succeed(false))
            ),
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
            const build = Effect.gen(function* () {
                yield* Stream.runForEach(raw.scanRows(table.name), (row) =>
                    Effect.gen(function* () {
                        const value = yield* codec("decode", () => table.decode(row.data));
                        const entries = yield* makeEntries(
                            { ...definition, unique: index.unique && !raw.nativeIndexes },
                            row.key,
                            value
                        );
                        for (const entry of entries) {
                            yield* raw.putEntry(entry);
                            if (
                                !index.multiEntry &&
                                (raw.nativeIndexes || typeof readField(value, index.field) === "string")
                            )
                                yield* raw.putEntry(foldedEntry(entry, value, index));
                        }
                    })
                );
                yield* raw.putIndex(definition);
                knownDefinitions.delete(table.name);
            });
            yield* build.pipe(
                Effect.onExit((exit) => {
                    if (Exit.isSuccess(exit)) return Effect.void;
                    // This unpublished index has no prior entries. Remove partial work so
                    // callers can catch validation errors and continue the transaction.
                    return raw.deleteEntries(table.name, index.name).pipe(
                        Effect.andThen(raw.deleteEntries(table.name, caseInsensitiveIndex(index.name))),
                        Effect.catchCause((cleanupCause) =>
                            Effect.flatMap(CurrentTransactions, (active) =>
                                Effect.sync(() => {
                                    // Failed cleanup must never allow partial index state to commit.
                                    active.get(identity)!.invalidate(Cause.combine(exit.cause, cleanupCause));
                                })
                            )
                        )
                    );
                })
            );
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
        allocateRevision: (stream, minimum) => guarded(api.allocateRevision(stream, minimum)),
        get: (table, key, options) => guarded(api.get(table, key, options)),
        getMany: (table, keys) => guarded(api.getMany(table, keys)),
        keys: (table, options) => guarded(api.keys(table, options)),
        query: guardedQuery,
        ...(raw.queryGrouped
            ? {
                  queryGrouped: <A>(table: ReadTable<A>, partition: Field, query: Query) =>
                      guarded(scanGrouped(table, partition, query)),
              }
            : {}),
        put: (table, key, value) => guarded(api.put(table, key, value)),
        putMany: (table, rows) => guarded(api.putMany(table, rows)),
        insert: (table, key, value) => guarded(api.insert(table, key, value)),
        delete: (table, key) => guarded(api.delete(table, key)),
        clear: (table) => guarded(api.clear(table)),
        ensureIndex: (table, index) => guarded(api.ensureIndex(table, index)),
    };
}
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
                const tx = transaction(raw, mode === "readwrite", () => open, identity);
                return provideTransaction(identity, tx, mode === "readwrite", () => body(tx)).pipe(
                    Effect.onExit(() =>
                        Effect.sync(() => {
                            open = false;
                        })
                    )
                );
            })
        );
    });
    const operation = <A>(
        mode: "readonly" | "readwrite",
        body: (tx: Transaction) => Effect.Effect<A, OntologyStorageError>
    ) =>
        Effect.flatMap(CurrentTransactions, (active) => {
            const state = active.get(identity);
            return state ? body(state.tx) : run(mode, body);
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
        [TransactionIdentity]: identity,
        transaction: (body) => run("readwrite", body),
        read: (body) => run("readonly", body),
        withTransaction: (effect) => run("readwrite", () => effect),
        withReadTransaction: (effect) => run("readonly", () => effect),
        allocateRevision: (stream, minimum) =>
            operation("readwrite", (tx) => tx.allocateRevision(stream, minimum)),
        get: (table, key, options) =>
            operation(options?.forUpdate ? "readwrite" : "readonly", (tx) => tx.get(table, key, options)),
        getMany: (table, keys) => operation("readonly", (tx) => tx.getMany(table, keys)),
        keys: (table, options) => operation("readonly", (tx) => tx.keys(table, options)),
        query,
        put: (table, key, value) => operation("readwrite", (tx) => tx.put(table, key, value)),
        putMany: (table, rows) => operation("readwrite", (tx) => tx.putMany(table, rows)),
        insert: (table, key, value) => operation("readwrite", (tx) => tx.insert(table, key, value)),
        delete: (table, key) => operation("readwrite", (tx) => tx.delete(table, key)),
        clear: (table) => operation("readwrite", (tx) => tx.clear(table)),
        ensureIndex: (table, index) => operation("readwrite", (tx) => tx.ensureIndex(table, index)),
    };
}
