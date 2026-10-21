import { Context, Effect, Layer } from "effect";
import {
    codecError,
    configurationError,
    DefinitionMismatch,
    OntologyStorageError,
    queryError,
} from "../errors.js";
import { Tables, type TablesService, type Transaction } from "../tables.js";
import { validateField, validateObjectQuery } from "./fields.js";
import { compiledModel, type ObjectStore, type StorageModel } from "./model.js";
import type { Index, Key, Query, Row } from "../model.js";

export interface ReadStorageTransaction {
    readonly get: <A, K extends Key>(
        object: ObjectStore<A, K>,
        key: NoInfer<K>
    ) => Effect.Effect<A | undefined, OntologyStorageError>;
    readonly loadSubset: <A>(
        object: ObjectStore<A>,
        query?: Query
    ) => Effect.Effect<Row<A>[], OntologyStorageError>;
}
export interface StorageTransaction extends ReadStorageTransaction {
    /** Derive the key from the ontology primary-key property. */
    readonly put: <A>(object: ObjectStore<A>, value: NoInfer<A>) => Effect.Effect<void, OntologyStorageError>;
    /** Explicit deletion; no cache policy or remote deletion is inferred. */
    readonly delete: <A, K extends Key>(
        object: ObjectStore<A, K>,
        key: NoInfer<K>
    ) => Effect.Effect<void, OntologyStorageError>;
    readonly ensureIndex: <A>(
        object: ObjectStore<A>,
        index: Index
    ) => Effect.Effect<void, OntologyStorageError>;
}
export interface OntologyStorageService extends StorageTransaction {
    readonly transaction: <A, E, R>(
        body: (tx: StorageTransaction) => Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | OntologyStorageError, R>;
    readonly read: <A, E, R>(
        body: (tx: ReadStorageTransaction) => Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | OntologyStorageError, R>;
    readonly withTransaction: <A, E, R>(
        effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | OntologyStorageError, R>;
    readonly withReadTransaction: <A, E, R>(
        effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | OntologyStorageError, R>;
}
export class OntologyStorage extends Context.Service<OntologyStorage, OntologyStorageService>()(
    "@party-stack/ontology-storage/OntologyStorage"
) {
    static readonly layer = (model: StorageModel) =>
        Layer.effect(
            OntologyStorage,
            Effect.map(Tables, (tables) => makeOntologyStorage(model, tables))
        );
}
const CurrentTransactions = Context.Reference<ReadonlyMap<symbol, StorageTransaction>>(
    "@party-stack/ontology-storage/CurrentObjectTransactions",
    { defaultValue: () => new Map() }
);
const convert = <A>(direction: "encode" | "decode", f: () => A) =>
    Effect.try({ try: f, catch: (cause) => codecError(direction, cause) });
const checkQuery = (f: () => void) => Effect.try({ try: f, catch: (cause) => queryError("query", cause) });

/** Wrap the ported engine; native transaction ownership stays with its driver. */
export function makeOntologyStorage(model: StorageModel, tables: TablesService): OntologyStorageService {
    const compiled = compiledModel(model);
    const identity = Symbol();
    const wrap = (tx: Transaction, writable: boolean): StorageTransaction => {
        let checked = false;
        const guard = Effect.gen(function* () {
            if (checked) return;
            const stored = yield* tx.get(compiled.stamp, "definition");
            if (stored && stored.signature !== compiled.signature)
                return yield* new OntologyStorageError({
                    operation: "definition",
                    reason: new DefinitionMismatch({
                        namespace: model.namespace,
                        expected: compiled.signature,
                        actual: stored.signature,
                        message:
                            "Ontology storage definition changed; migrate explicitly before reopening this namespace.",
                    }),
                });
            if (!stored && writable)
                yield* tx.put(compiled.stamp, "definition", { signature: compiled.signature });
            checked = true;
        });
        const store = (object: ObjectStore<unknown>) =>
            Effect.suspend(() => {
                const definition = compiled.stores.get(object);
                return definition
                    ? Effect.succeed(definition)
                    : Effect.fail(
                          configurationError("object", "Object store belongs to another storage model.")
                      );
            });
        const key = (object: ObjectStore<unknown>, input: Key) =>
            Effect.try({
                try: () => compiled.stores.get(object)!.key(input),
                catch: (cause) => queryError(`key:${object.name}`, cause),
            });
        return {
            get: Effect.fnUntraced(function* <A, K extends Key>(object: ObjectStore<A, K>, input: K) {
                const definition = yield* store(object);
                yield* guard;
                const value = yield* tx.get(definition.table, yield* key(object, input));
                return value === undefined
                    ? undefined
                    : ((yield* convert("decode", () => definition.decode(value))) as A);
            }),
            loadSubset: Effect.fnUntraced(function* <A>(object: ObjectStore<A>, query: Query = {}) {
                const definition = yield* store(object);
                yield* checkQuery(() => validateObjectQuery(compiled.ir, object, query));
                yield* guard;
                const rows = yield* tx.loadSubset(definition.table, query);
                return yield* convert("decode", () =>
                    rows.map((row) => ({ key: row.key, value: definition.decode(row.value) as A }))
                );
            }),
            put: Effect.fnUntraced(function* <A>(object: ObjectStore<A>, value: A) {
                const definition = yield* store(object);
                const encoded = yield* convert("encode", () => definition.encode(value));
                const primaryKey = encoded[object.definition.primaryKey];
                if (typeof primaryKey !== "string" && typeof primaryKey !== "number")
                    return yield* Effect.fail(
                        codecError("encode", new TypeError(`Invalid primary key for ${object.name}.`))
                    );
                const input = yield* key(object, primaryKey);
                yield* guard;
                yield* tx.put(definition.table, input, encoded);
            }),
            delete: Effect.fnUntraced(function* <A, K extends Key>(object: ObjectStore<A, K>, input: K) {
                const definition = yield* store(object);
                yield* guard;
                yield* tx.delete(definition.table, yield* key(object, input));
            }),
            ensureIndex: Effect.fnUntraced(function* <A>(object: ObjectStore<A>, index: Index) {
                const definition = yield* store(object);
                yield* checkQuery(() => validateField(compiled.ir, object, index.field, index.multiEntry));
                yield* guard;
                yield* tx.ensureIndex(definition.table, index);
            }),
        };
    };
    const run = <A, E, R>(writable: boolean, body: (tx: StorageTransaction) => Effect.Effect<A, E, R>) => {
        const inside = (raw: Transaction) => {
            const tx = wrap(raw, writable);
            return Effect.flatMap(CurrentTransactions, (active) =>
                body(tx).pipe(
                    Effect.provideService(CurrentTransactions, new Map([...active, [identity, tx]]))
                )
            );
        };
        // Read transactions have the same runtime operations with write rejection.
        return writable ? tables.transaction(inside) : tables.read((raw) => inside(raw as Transaction));
    };
    const operation = <A>(
        writable: boolean,
        body: (tx: StorageTransaction) => Effect.Effect<A, OntologyStorageError>
    ) =>
        Effect.flatMap(CurrentTransactions, (active) => {
            const tx = active.get(identity);
            return tx ? body(tx) : run(writable, body);
        });
    return {
        get: (object, key) => operation(false, (tx) => tx.get(object, key)),
        loadSubset: (object, query) => operation(false, (tx) => tx.loadSubset(object, query)),
        put: (object, value) => operation(true, (tx) => tx.put(object, value)),
        delete: (object, key) => operation(true, (tx) => tx.delete(object, key)),
        ensureIndex: (object, index) => operation(true, (tx) => tx.ensureIndex(object, index)),
        transaction: (body) => run(true, body),
        read: (body) => run(false, body),
        withTransaction: (effect) => run(true, () => effect),
        withReadTransaction: (effect) => run(false, () => effect),
    };
}
