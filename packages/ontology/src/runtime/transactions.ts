import { BackendError } from "@party-stack/ontology-backend";
import { executeAction } from "@party-stack/ontology-backend/actions";
import { Table } from "@party-stack/ontology-storage/tables";
import { BasicIndex, whenSyncAccepted, DbClient, collectionOptions } from "@tanstack/db";
import { Effect, Fiber, Semaphore } from "effect";
import { createReadTx } from "../live/mutators/createReadTx.js";
import { storageSubset } from "../tanstack/index.js";
import type { ActionRequest } from "@party-stack/ontology-backend";
type ExpressionReplay = NonNullable<ActionRequest["replay"]>;
import type { OntologyMutatorTx } from "../live/mutators/types.js";
import type { OntologyMutatorRegistry, PrepareTransactionSources } from "../live/mutators/types.js";
import type { ActionMutatorRegistry } from "@party-stack/ontology-backend/actions";
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

/** Promise/TanStack authoring bridge only. Portable action logic and replay live below ontology. */
export const actionMutators = (
    ir: OntologyIR,
    registry: OntologyMutatorRegistry = {}
): ActionMutatorRegistry =>
    Object.fromEntries(
        Object.entries(registry).map(([name, handler]) => [
            name,
            (tx, request, context) =>
                Effect.scoped(
                    Effect.gen(function* () {
                        const services = yield* Effect.context<never>();
                        const scope = yield* Effect.scope;
                        let closed = false;
                        const reads = new Map<string, unknown>();
                        const codec = Table.make({ name: "mutator-reads" });
                        const cached = <A>(key: unknown, work: Effect.Effect<A, BackendError>) =>
                            Effect.suspend(() => {
                                const encoded = codec.encode(key);
                                return reads.has(encoded)
                                    ? Effect.succeed(reads.get(encoded) as A)
                                    : work.pipe(
                                          Effect.tap((value) => Effect.sync(() => reads.set(encoded, value)))
                                      );
                            });
                        const invalidate = Effect.sync(() => reads.clear());
                        const mutations = yield* Semaphore.make(1);
                        const local: OwnedReadTransaction = {
                            get: (type, key) => cached(["get", type, key], tx.get(type, key)),
                            loadSubset: (type, scan) =>
                                cached(["query", type, scan], tx.loadSubset(type, scan)),
                        };
                        yield* Effect.addFinalizer(() =>
                            Effect.sync(() => {
                                closed = true;
                                reads.clear();
                            })
                        );
                        const run = <A>(work: Effect.Effect<A, BackendError>) =>
                            Effect.runPromiseWith(services)(
                                Effect.suspend(() =>
                                    closed
                                        ? Effect.fail(failure("Mutator scope is closed."))
                                        : Effect.flatMap(Effect.forkIn(work, scope), Fiber.join)
                                )
                            );
                        const read: ReturnType<typeof createReadTx> = {
                            query: <A>(build: Parameters<ReturnType<typeof createReadTx>["query"]>[0]) =>
                                run(
                                    withTransactionCollections(ir, local, (objects, prepare) =>
                                        Effect.tryPromise({
                                            try: () => createReadTx(objects, prepare).query<A>(build),
                                            catch: failure,
                                        })
                                    )
                                ),
                        };
                        const runMutation = <A>(work: Effect.Effect<A, BackendError>) =>
                            run(mutations.withPermits(1)(work));
                        const mutate = new Proxy(
                            {},
                            {
                                get: (_target, type: string) => {
                                    const definition = ir.objectTypes.find((t) => t.name === type);
                                    if (!definition) throw failure(`Unknown object type "${type}".`);
                                    const requireObject = (key: string | number) =>
                                        tx.get(type, key).pipe(
                                            Effect.flatMap((value) =>
                                                value
                                                    ? Effect.void
                                                    : Effect.fail(
                                                          new BackendError({
                                                              operation: "mutator",
                                                              kind: "NotFound",
                                                              retryable: false,
                                                              message: "Object is unavailable.",
                                                          })
                                                      )
                                            )
                                        );
                                    return {
                                        create: (value: Record<string, unknown>) =>
                                            runMutation(
                                                Effect.gen(function* () {
                                                    const key = value[definition.primaryKey];
                                                    if (typeof key !== "string" && typeof key !== "number")
                                                        return yield* failure(
                                                            "Created object requires its primary key."
                                                        );
                                                    if (yield* tx.get(type, key))
                                                        return yield* new BackendError({
                                                            operation: "mutator.create",
                                                            kind: "Conflict",
                                                            retryable: false,
                                                            message: "Object already exists.",
                                                        });
                                                    yield* tx.put(type, value);
                                                }).pipe(Effect.ensuring(invalidate))
                                            ),
                                        update: (
                                            key: string | number,
                                            changes:
                                                | Record<string, unknown>
                                                | { path: string[]; value: unknown }[]
                                        ) =>
                                            runMutation(
                                                requireObject(key).pipe(
                                                    Effect.andThen(
                                                        tx.patch(
                                                            type,
                                                            key,
                                                            Array.isArray(changes)
                                                                ? changes
                                                                : Object.entries(changes).map(
                                                                      ([property, value]) => ({
                                                                          path: [property],
                                                                          value,
                                                                      })
                                                                  )
                                                        )
                                                    ),
                                                    Effect.ensuring(invalidate)
                                                )
                                            ),
                                        delete: (key: string | number) =>
                                            runMutation(
                                                requireObject(key).pipe(
                                                    Effect.andThen(tx.delete(type, key)),
                                                    Effect.ensuring(invalidate)
                                                )
                                            ),
                                    };
                                },
                            }
                        ) as OntologyMutatorTx["mutate"];
                        return yield* Effect.tryPromise({
                            try: () =>
                                Promise.resolve(
                                    handler({ tx: { ...read, mutate }, args: request.parameters, context })
                                ),
                            catch: failure,
                        });
                    })
                ),
        ])
    );

export const executeTransactionMutator = Effect.fn("Ontology.executeMutator")(function* (options: {
    readonly ir: OntologyIR;
    readonly tx: OwnedTransaction;
    readonly name: string;
    readonly parameters: Record<string, unknown>;
    readonly operationId: string;
    readonly replay?: ExpressionReplay;
    readonly resolveOnly?: boolean;
    readonly context?: Record<string, unknown>;
    readonly mutators?: OntologyMutatorRegistry;
}) {
    return yield* executeAction({
        ir: options.ir,
        tx: options.tx,
        request: {
            id: options.operationId,
            name: options.name,
            parameters: options.parameters,
            replay: options.replay,
        },
        context: options.context,
        resolveOnly: options.resolveOnly,
        mutators: actionMutators(options.ir, options.mutators),
    }).pipe(Effect.map((execution) => execution.result));
});
