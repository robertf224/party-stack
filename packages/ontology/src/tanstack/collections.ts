import { Table } from "@party-stack/ontology-storage/tables";
import { Runtime } from "@party-stack/runtime";
import { BasicIndex, createCollection, collectionOptions, whenSyncAccepted } from "@tanstack/db";
import { Effect, Exit, Fiber, Scope, Stream } from "effect";
import { registerCollectionDemands, type CollectionDemandDiagnostic } from "./diagnostics.js";
import { analyzeStorageSubset, storageSubset } from "./subset.js";
import type { ReplicaService } from "@party-stack/ontology-replica";
import type { Key } from "@party-stack/ontology-storage";
import type { CollectionConfig, DbClient, LoadSubsetOptions } from "@tanstack/db";

interface Change<A> {
    readonly key: Key;
    readonly type: "insert" | "update" | "delete";
    readonly modified: A;
}
/** Options creators are Effects: their callback fibers and subscriptions belong to the caller's scope. */
export const persistedCollectionOptions = Effect.fnUntraced(function* <
    A extends object,
    K extends Key,
>(options: {
    readonly id: string;
    readonly getKey: (value: A) => K;
    readonly load:
        | Effect.Effect<readonly { key: Key; value: A }[], unknown>
        | ((subset: LoadSubsetOptions) => Effect.Effect<readonly { key: Key; value: A }[], unknown>);
    readonly changes: Stream.Stream<void>;
    readonly persist?: (mutations: readonly Change<A>[]) => Effect.Effect<void, unknown>;
    readonly acquireDemand?:
        | Effect.Effect<void, unknown, Scope.Scope>
        | ((subset: LoadSubsetOptions) => Effect.Effect<void, unknown, Scope.Scope>);
    readonly describeSubset?: (subset: LoadSubsetOptions) => Omit<CollectionDemandDiagnostic, "subscription">;
}) {
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<never>();
    let active = true;
    yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
            active = false;
        })
    );
    const run = <B, E>(effect: Effect.Effect<B, E>, owner = scope) =>
        !active
            ? Promise.reject(new Error("Collection scope is closed."))
            : Effect.runPromiseWith(context)(Effect.flatMap(Effect.forkIn(effect, owner), Fiber.join));
    let refresh: (() => Promise<void>) | undefined;
    let queried = false;
    const persist: (args: {
        transaction: { mutations: readonly (Change<A> & { collection: unknown })[] };
        collection: unknown;
    }) => Promise<void> = options.persist
        ? async ({ transaction, collection }) => {
              await run(
                  options.persist!(
                      transaction.mutations.filter((mutation) => mutation.collection === collection)
                  )
              );
              // In particular, optimistic:false callers must observe the confirmed write
              // as soon as isPersisted resolves (OAuth immediately looks up its new session).
              await refresh?.();
          }
        : () => Promise.reject(new Error("This collection is read-only. Use ontology actions to mutate it."));
    const config: CollectionConfig<A, K> = {
        id: options.id,
        getKey: options.getKey,
        defaultIndexType: BasicIndex,
        autoIndex: "eager",
        syncMode: "on-demand",
        startSync: true,
        onInsert: persist,
        onUpdate: persist,
        onDelete: persist,
        sync: {
            sync: ({ begin, write, commit, markReady, markError, collection }) => {
                let alive = true;
                let tail = Promise.resolve();
                const releasing = new Set<Promise<void>>();
                const demands = new Map<
                    LoadSubsetOptions,
                    {
                        scope: Scope.Closeable;
                        ready: Promise<void>;
                        subset: LoadSubsetOptions;
                        release: () => void;
                    }
                >();
                const releaseDiagnostics = options.describeSubset
                    ? registerCollectionDemands(collection, () =>
                          [...demands.keys()].map((subset) => ({
                              ...options.describeSubset!(subset),
                              subscription: subset.subscription,
                          }))
                      )
                    : undefined;
                const load = () => {
                    const next = tail.then(async () => {
                        if (!active || !alive) return;
                        const rows = new Map<Key, A>();
                        if (typeof options.load !== "function") {
                            for (const row of await run(options.load)) rows.set(row.key, row.value);
                        }
                        const current = Array.from(demands.entries());
                        for (const [key, demand] of current) {
                            if (typeof options.load !== "function") break;
                            const loaded = await run(options.load(demand.subset));
                            if (demands.get(key) !== demand) continue;
                            for (const row of loaded) rows.set(row.key, row.value);
                        }
                        if (!active || !alive) return;
                        const stale = new Set(collection.keys());
                        begin();
                        for (const [key, value] of rows) {
                            write({ type: stale.has(key as K) ? "update" : "insert", value });
                            stale.delete(key as K);
                        }
                        for (const key of stale) write({ type: "delete", key });
                        const receipt = commit();
                        if (receipt !== true) void receipt.catch(markError);
                        await whenSyncAccepted(receipt);
                    });
                    tail = next.catch(() => undefined);
                    return next;
                };
                refresh = load;
                const watcher = run(
                    Effect.forkIn(
                        Stream.runForEach(options.changes, () =>
                            queried && (demands.size || typeof options.load !== "function")
                                ? Effect.tryPromise({ try: load, catch: (cause) => cause })
                                : Effect.void
                        ).pipe(
                            Effect.catch((error) =>
                                Effect.sync(() => {
                                    if (alive) markError(error);
                                })
                            )
                        ),
                        scope
                    )
                );
                markReady();
                return {
                    loadSubset: (subset) => {
                        if (subset.signal?.aborted) return Promise.resolve();
                        queried = true;
                        // Each acquisition has its own immutable options, signal
                        // and matching unload, even for equivalent queries.
                        const key = subset;
                        let demand = demands.get(key);
                        if (!demand) {
                            const child = Effect.runSync(Scope.fork(scope));
                            const acquire = options.acquireDemand;
                            demand = {
                                scope: child,
                                subset,
                                ready: Promise.resolve(),
                                release: () => {
                                    subset.signal?.removeEventListener("abort", demand!.release);
                                    if (demands.get(key) !== demand) return;
                                    demands.delete(key);
                                    const closing = Effect.runPromise(Scope.close(child, Exit.void));
                                    releasing.add(closing);
                                    void closing.then(
                                        () => releasing.delete(closing),
                                        (error) => {
                                            releasing.delete(closing);
                                            if (alive && active) markError(error);
                                        }
                                    );
                                    if (alive && active && demands.size) void load().catch(markError);
                                },
                            };
                            demands.set(key, demand);
                            subset.signal?.addEventListener("abort", demand.release, { once: true });
                            demand.ready = acquire
                                ? run(
                                      Scope.provide(
                                          typeof acquire === "function" ? acquire(subset) : acquire,
                                          child
                                      ),
                                      child
                                  )
                                : Promise.resolve();
                            void demand.ready.catch(() => demand!.release());
                        }
                        return demand.ready.then(load);
                    },
                    unloadSubset: (subset) => {
                        const demand = demands.get(subset);
                        demand?.release();
                    },
                    cleanup: async () => {
                        releaseDiagnostics?.();
                        alive = false;
                        refresh = undefined;
                        await watcher.then(
                            (fiber) => Effect.runPromise(Fiber.interrupt(fiber)),
                            () => undefined
                        );
                        await Promise.all([
                            ...releasing,
                            ...[...demands.values()].map((demand) => {
                                demand.subset.signal?.removeEventListener("abort", demand.release);
                                return Effect.runPromise(Scope.close(demand.scope, Exit.void));
                            }),
                        ]);
                        demands.clear();
                    },
                };
            },
        },
    };
    return config;
});
export const localCollectionOptions = Effect.fnUntraced(function* <A extends object, K extends Key>(options: {
    readonly name: string;
    readonly getKey: (value: A) => K;
    readonly schemaVersion?: number;
}) {
    const runtime = yield* Runtime;
    const table = Table.make<A>({
        name: JSON.stringify(["local", runtime.adapter.owner, runtime.adapter.namespace, options.name]),
        version: options.schemaVersion,
    });
    const config = yield* persistedCollectionOptions<A, K>({
        id: `party-stack:${runtime.adapter.owner}:${runtime.adapter.namespace}:${options.name}`,
        getKey: options.getKey,
        load: (subset) => runtime.tables.loadSubset(table, storageSubset(subset)),
        changes: yield* runtime.subscribeChanges,
        persist: (mutations) =>
            runtime.tables
                .transaction((tx) =>
                    Effect.gen(function* () {
                        for (const mutation of mutations) {
                            if (mutation.type === "delete") yield* tx.delete(table, mutation.key);
                            else yield* tx.put(table, mutation.key, mutation.modified);
                        }
                    })
                )
                .pipe(Effect.tap(() => runtime.notify)),
    });
    return config;
});
export const replicatedCollectionOptions = Effect.fnUntraced(function* <A extends object>(options: {
    readonly replica: ReplicaService;
    readonly objectType: string;
    readonly getKey: (value: A) => Key;
    readonly id: string;
    readonly persistedOnly?: boolean;
    readonly map?: (value: A) => A;
}) {
    return yield* persistedCollectionOptions<A, Key>({
        id: options.id,
        getKey: options.getKey,
        describeSubset: (subset) => ({
            objectType: options.objectType,
            ...analyzeStorageSubset(subset, options.replica.ir, options.objectType),
            requested: {
                where: subset.where,
                orderBy: subset.orderBy,
                limit: subset.limit,
                offset: subset.offset,
                cursor: subset.cursor,
            },
        }),
        load: (subset) =>
            Effect.map(
                options.replica.loadSubset(
                    options.objectType,
                    storageSubset(subset, options.replica.ir, options.objectType)
                ),
                (rows) =>
                    rows.map((row) => ({
                        key: row.key,
                        value: options.map ? options.map(row.value as A) : (row.value as A),
                    }))
            ),
        changes: yield* options.replica.subscribeChanges,
        acquireDemand: (subset) =>
            options.persistedOnly
                ? options.replica.retainLocal(
                      options.objectType,
                      storageSubset(subset, options.replica.ir, options.objectType)
                  )
                : options.replica
                      .demand({
                          objectType: options.objectType,
                          query: storageSubset(subset, options.replica.ir, options.objectType),
                      })
                      .pipe(Effect.andThen(options.replica.syncOnce)),
    });
});
export const scopedCollection = <A extends object, K extends Key>(
    options: CollectionConfig<A, K>,
    client?: DbClient
) =>
    client
        ? Effect.sync(() => client.collection(collectionOptions(options)))
        : Effect.acquireRelease(
              Effect.sync(() => createCollection(options)),
              (collection) =>
                  Effect.promise(async () => {
                      await collection.cleanup();
                  })
          );
export const makeLocalCollection = Effect.fn("Ontology.localCollection")(function* <
    A extends object,
    K extends Key,
>(options: Parameters<typeof localCollectionOptions<A, K>>[0]) {
    return yield* scopedCollection(yield* localCollectionOptions(options));
});
export const makeReplicatedCollection = Effect.fn("Ontology.replicatedCollection")(function* <
    A extends object,
>(options: Parameters<typeof replicatedCollectionOptions<A>>[0], client?: DbClient) {
    return yield* scopedCollection(yield* replicatedCollectionOptions(options), client);
});
