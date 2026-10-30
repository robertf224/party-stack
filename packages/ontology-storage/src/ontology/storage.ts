import { Context, Effect, Layer } from "effect";
import { collectObjectAttachments, type BlobStorageService } from "../blobs/index.js";
import {
    codecError,
    attachmentError,
    configurationError,
    DefinitionMismatch,
    OntologyStorageError,
    queryError,
} from "../errors.js";
import { executeQuery } from "../query/execute.js";
import { Tables, type TablesService, type Transaction } from "../tables.js";
import { useTransaction } from "../transactionContext.js";
import { validateField, validateObjectQuery } from "./fields.js";
import { compiledModel, type ObjectStore, type StorageModel } from "./model.js";
import type { Index, Key, Query, Row } from "../model.js";
import type { TransactionState } from "../transactionContext.js";
import type { QueryDocument } from "@party-stack/ontology-spec";

export interface StorageQueryOptions {
    readonly inputs?: Record<string, unknown>;
    readonly context?: Record<string, unknown>;
}
/** Full ontology projections, or a typed single-object scan without projection. */
export interface StorageQuery {
    (
        document: QueryDocument,
        options?: StorageQueryOptions
    ): Effect.Effect<Record<string, unknown>, OntologyStorageError>;
    <A>(object: ObjectStore<A>, scan?: Query): Effect.Effect<Row<A>[], OntologyStorageError>;
}
export interface ReadStorageTransaction {
    readonly get: <A, K extends Key>(
        object: ObjectStore<A, K>,
        key: NoInfer<K>
    ) => Effect.Effect<A | undefined, OntologyStorageError>;
    readonly query: StorageQuery;
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
    /** Any failed object mutation makes this transaction rollback-only, even if caught. */
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
const convert = <A>(direction: "encode" | "decode", f: () => A) =>
    Effect.try({ try: f, catch: (cause) => codecError(direction, cause) });
const checkQuery = (f: () => void) => Effect.try({ try: f, catch: (cause) => queryError("query", cause) });

/** Wrap the ported engine; native transaction ownership stays with its driver. */
export function makeOntologyStorage(
    model: StorageModel,
    tables: TablesService,
    options?: { readonly blobs?: BlobStorageService }
): OntologyStorageService {
    const compiled = compiledModel(model);
    const identity = Symbol();
    const wrap = (
        tx: Transaction,
        writable: boolean,
        mutation: TransactionState["mutation"]
    ): StorageTransaction => {
        let checked = false;
        const guard = Effect.gen(function* () {
            // Even a literal-only query must reject an escaped transaction handle.
            yield* tx.query(compiled.stamp, { limit: 0 });
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
        const scan = Effect.fnUntraced(function* <A>(object: ObjectStore<A>, query: Query = {}) {
            const definition = yield* store(object);
            yield* checkQuery(() => validateObjectQuery(compiled.ir, object, query));
            yield* guard;
            const rows = yield* tx.query(definition.table, query);
            return yield* convert("decode", () =>
                rows.map((row) => ({ key: row.key, value: definition.decode(row.value) as A }))
            );
        });

        function query(
            document: QueryDocument,
            options?: StorageQueryOptions
        ): Effect.Effect<Record<string, unknown>, OntologyStorageError>;
        function query<A>(
            object: ObjectStore<A>,
            scan?: Query
        ): Effect.Effect<Row<A>[], OntologyStorageError>;
        function query<A>(
            request: QueryDocument | ObjectStore<A>,
            options: StorageQueryOptions | Query = {}
        ) {
            if (!("select" in request)) return scan(request, options as Query);
            return Effect.gen(function* () {
                yield* guard;
                const result = yield* executeQuery(request, {
                    ...(options as StorageQueryOptions),
                    error: (failure) => queryError("query", new Error(failure.message, { cause: failure })),
                    reader: {
                        ir: compiled.ir,
                        loadSubset: (name, query) =>
                            Effect.gen(function* () {
                                const object = model.objects[name];
                                if (!object)
                                    return yield* queryError("query", `Unknown object type: ${name}`);
                                yield* checkQuery(() =>
                                    validateObjectQuery(compiled.ir, object, query ?? {})
                                );
                                const definition = yield* store(object);
                                return yield* tx.query(definition.table, query);
                            }),
                    },
                });
                return result.value;
            });
        }
        const api: StorageTransaction = {
            get: Effect.fnUntraced(function* <A, K extends Key>(object: ObjectStore<A, K>, input: K) {
                const definition = yield* store(object);
                yield* guard;
                const value = yield* tx.get(definition.table, yield* key(object, input));
                return value === undefined
                    ? undefined
                    : ((yield* convert("decode", () => definition.decode(value))) as A);
            }),
            query,
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
                if (options?.blobs)
                    yield* options.blobs
                        .in(tx)
                        .retain(
                            JSON.stringify(["object", model.namespace, object.name, input]),
                            collectObjectAttachments(compiled.ir, object.name, encoded).map(
                                (entry) => entry.attachment.id
                            ),
                            { bytes: false }
                        )
                        .pipe(Effect.mapError((cause) => attachmentError("attachment.retain", cause)));
                yield* tx.put(definition.table, input, encoded);
            }, mutation),
            delete: Effect.fnUntraced(function* <A, K extends Key>(object: ObjectStore<A, K>, input: K) {
                const definition = yield* store(object);
                yield* guard;
                const selected = yield* key(object, input);
                if (options?.blobs)
                    yield* options.blobs
                        .in(tx)
                        .release(JSON.stringify(["object", model.namespace, object.name, selected]))
                        .pipe(Effect.mapError((cause) => attachmentError("attachment.release", cause)));
                yield* tx.delete(definition.table, selected);
            }, mutation),
            ensureIndex: Effect.fnUntraced(function* <A>(object: ObjectStore<A>, index: Index) {
                const definition = yield* store(object);
                yield* checkQuery(() => validateField(compiled.ir, object, index.field, index.multiEntry));
                yield* guard;
                yield* tx.ensureIndex(definition.table, index);
            }, mutation),
        };
        return api;
    };
    const operation = <A, E, R>(
        writable: boolean,
        body: (tx: StorageTransaction) => Effect.Effect<A, E, R>
    ) =>
        useTransaction(tables, writable, (state) =>
            Effect.suspend(() => {
                let tx = state.bindings.get(identity) as StorageTransaction | undefined;
                if (!tx) {
                    tx = wrap(state.tx, state.writable, state.mutation);
                    state.bindings.set(identity, tx);
                }
                return body(tx);
            })
        );
    const run = <A, E, R>(writable: boolean, body: (tx: StorageTransaction) => Effect.Effect<A, E, R>) =>
        writable
            ? tables.transaction(() => operation(true, body))
            : tables.read(() => operation(false, body));
    function query(
        document: QueryDocument,
        options?: StorageQueryOptions
    ): Effect.Effect<Record<string, unknown>, OntologyStorageError>;
    function query<A>(object: ObjectStore<A>, scan?: Query): Effect.Effect<Row<A>[], OntologyStorageError>;
    function query<A>(request: QueryDocument | ObjectStore<A>, options: StorageQueryOptions | Query = {}) {
        return "select" in request
            ? operation(false, (tx) => tx.query(request, options as StorageQueryOptions))
            : operation(false, (tx) => tx.query(request, options as Query));
    }
    return {
        get: (object, key) => operation(false, (tx) => tx.get(object, key)),
        query,
        put: (object, value) => operation(true, (tx) => tx.put(object, value)),
        delete: (object, key) => operation(true, (tx) => tx.delete(object, key)),
        ensureIndex: (object, index) => operation(true, (tx) => tx.ensureIndex(object, index)),
        transaction: (body) => run(true, body),
        read: (body) => run(false, body),
        withTransaction: (effect) => run(true, () => effect),
        withReadTransaction: (effect) => run(false, () => effect),
    };
}
