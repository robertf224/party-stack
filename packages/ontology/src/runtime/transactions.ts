import { BackendError } from "@party-stack/ontology-backend";
import { Table } from "@party-stack/ontology-storage/tables";
import { BasicIndex, whenSyncAccepted, DbClient, collectionOptions } from "@tanstack/db";
import { Effect, Fiber } from "effect";
import { resolveActionParameters } from "../live/expression.js";
import { createReadTx } from "../live/mutators/createMutatorTx.js";
import { runOptimisticAction } from "../live/mutators/runOptimisticAction.js";
import { storageSubset } from "../tanstack/index.js";
import type { OntologyMutatorRegistry, PrepareTransactionSources } from "../live/mutators/types.js";
import type { OwnedReadTransaction, OwnedTransaction } from "@party-stack/ontology-backend/owned";
import type { OntologyIR, OntologyObject } from "@party-stack/ontology-spec";
import type { Collection } from "@tanstack/db";

const failure = (cause: unknown) =>
    cause instanceof BackendError
        ? cause
        : new BackendError({
              operation: "mutator",
              kind: "Internal",
              message: cause instanceof Error ? cause.message : "Transaction execution failed.",
              retryable: false,
              cause,
          });

/** Ephemeral query collections; their only source is the supplied persisted transaction. */
export const withTransactionCollections = <A, E, R>(
    ir: OntologyIR,
    tx: OwnedReadTransaction,
    body: (
        objects: Record<string, Collection<OntologyObject>>,
        ensureLoaded: PrepareTransactionSources,
        client: DbClient
    ) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | BackendError, R> =>
    Effect.scoped(
        Effect.gen(function* () {
            const context = yield* Effect.context<never>();
            const scope = yield* Effect.scope;
            let closed = false;
            yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                    closed = true;
                })
            );
            const run = <B, F>(effect: Effect.Effect<B, F>) =>
                closed
                    ? Promise.reject(failure("Transaction query scope is closed."))
                    : Effect.runPromiseWith(context)(
                          Effect.flatMap(Effect.forkIn(effect, scope), Fiber.join)
                      );
            const client = yield* Effect.acquireRelease(
                Effect.sync(() => new DbClient()),
                (client) => Effect.promise(() => client.cleanup())
            );
            const publishers = new Map<
                string,
                (rows: readonly { key: string | number; value: OntologyObject }[]) => Promise<void>
            >();
            const loaded = new Map<string, Promise<void>>();
            const objects = Object.fromEntries(
                ir.objectTypes.map((definition) => [
                    definition.name,
                    client.collection(
                        collectionOptions({
                            id: `transaction:${crypto.randomUUID()}:${definition.name}`,
                            getKey: (value: OntologyObject) =>
                                value[definition.primaryKey] as string | number,
                            syncMode: "on-demand",
                            defaultIndexType: BasicIndex,
                            autoIndex: "eager",
                            startSync: true,
                            sync: {
                                sync: ({ begin, write, commit, markReady, markError }) => {
                                    const published = new Set<string | number>();
                                    const requests = new Map<string, Promise<void>>();
                                    publishers.set(definition.name, async (rows) => {
                                        if (closed) throw failure("Transaction query scope is closed.");
                                        begin();
                                        for (const row of rows) {
                                            write({
                                                type: published.has(row.key) ? "update" : "insert",
                                                value: row.value,
                                            });
                                            published.add(row.key);
                                        }
                                        const receipt = commit();
                                        if (receipt !== true) void receipt.catch(markError);
                                        await whenSyncAccepted(receipt);
                                    });
                                    markReady();
                                    return {
                                        loadSubset: (subset) => {
                                            const query = storageSubset(subset, ir, definition.name);
                                            const key = Table.make({ name: "transaction-demand" }).encode(
                                                query
                                            );
                                            let pending = requests.get(key);
                                            if (!pending) {
                                                pending = run(
                                                    Effect.flatMap(
                                                        tx.loadSubset(definition.name, query),
                                                        (rows) =>
                                                            Effect.promise(() =>
                                                                publishers.get(definition.name)!(rows)
                                                            )
                                                    )
                                                );
                                                requests.set(key, pending);
                                                void pending.catch(() => requests.delete(key));
                                            }
                                            return pending;
                                        },
                                        cleanup: () => {
                                            publishers.delete(definition.name);
                                        },
                                    };
                                },
                            },
                        })
                    ),
                ])
            );
            const ensureLoaded: PrepareTransactionSources = async (types, request) => {
                // TanStack drives query sources, join key batches and includes
                // through loadSubset. Only imperative edits need preparation.
                if (request?.plan !== undefined) return;
                for (const type of types) {
                    const key = JSON.stringify([type, request?.key]);
                    let pending = loaded.get(key);
                    if (!pending) {
                        const publish = publishers.get(type);
                        if (!publish) throw failure("Unknown transaction query source.");
                        const read =
                            request?.key === undefined
                                ? tx.loadSubset(type)
                                : Effect.map(tx.get(type, request.key), (value) =>
                                      value === undefined ? [] : [{ key: request.key!, value }]
                                  );
                        pending = run(Effect.flatMap(read, (rows) => Effect.promise(() => publish(rows))));
                        loaded.set(key, pending);
                    }
                    await pending;
                }
            };
            return yield* body(objects, ensureLoaded, client);
        })
    );

export const executeTransactionMutator = Effect.fn("Ontology.executeMutator")(function* (options: {
    readonly ir: OntologyIR;
    readonly tx: OwnedTransaction;
    readonly name: string;
    readonly parameters: Record<string, unknown>;
    readonly operationId: string;
    readonly replay?: import("../live/expression.js").ExpressionReplay;
    /** Resolve portable inputs without constructing a local optimistic result. Authoritative execution omits this flag. */
    readonly resolveOnly?: boolean;
    readonly context?: Record<string, unknown>;
    readonly mutators?: OntologyMutatorRegistry;
}): Effect.fn.Return<Record<string, unknown>, BackendError> {
    return yield* withTransactionCollections(options.ir, options.tx, (objects, ensureLoaded, client) =>
        Effect.gen(function* () {
            const services = yield* Effect.context<never>();
            const run = Effect.runPromiseWith(services);
            const transaction = client.createTransaction<OntologyObject>({
                autoCommit: false,
                mutationFn: async ({ transaction }) => {
                    for (const mutation of transaction.mutations) {
                        const objectType = Object.entries(objects).find(
                            ([, collection]) => collection === mutation.collection
                        )?.[0];
                        if (!objectType) throw failure("Mutation belongs to another transaction.");
                        if (mutation.type === "delete") {
                            await run(options.tx.delete(objectType, mutation.key));
                        } else {
                            await run(options.tx.put(objectType, mutation.modified));
                        }
                    }
                },
            });
            void transaction.isPersisted.promise.catch(() => undefined);
            return yield* Effect.tryPromise({
                try: async () => {
                    try {
                        const parameters = await resolveActionParameters({
                            ir: options.ir,
                            actionTypeName: options.name,
                            initialParameters: options.parameters,
                            context: options.context ?? {},
                            replay: options.replay,
                            tx: createReadTx(objects, ensureLoaded),
                        });
                        if (options.resolveOnly) {
                            transaction.rollback();
                            return parameters;
                        }
                        await runOptimisticAction({
                            ir: options.ir,
                            actionTypeName: options.name,
                            parameters,
                            context: options.context ?? {},
                            replay: options.replay,
                            transaction,
                            objects,
                            idempotencyKey: options.operationId,
                            mutators: options.mutators,
                            ensureLoaded,
                        });
                        await transaction.commit();
                        return parameters;
                    } catch (cause) {
                        if (transaction.state === "pending") transaction.rollback();
                        throw cause;
                    }
                },
                catch: failure,
            });
        })
    );
});
