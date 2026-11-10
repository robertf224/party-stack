import { coversSubset } from "@party-stack/ontology-backend/subset";
import { readVisibleRevision } from "@party-stack/ontology-replica/infrastructure";
import { Table } from "@party-stack/ontology-storage/tables";
import { Runtime } from "@party-stack/runtime";
import { BasicIndex, createCollection, collectionOptions, whenSyncAccepted, IR } from "@tanstack/db";
import { Deferred, Effect, Exit, Fiber, Scope, Stream, Queue } from "effect";
import { registerCollectionDemands, type CollectionDemandDiagnostic } from "./diagnostics.js";
import { analyzeOntologySubset, analyzeStorageSubset, storageSubset, ontologySubset } from "./subset.js";
import type { ReplicaService } from "@party-stack/ontology-replica";
import type { Key } from "@party-stack/ontology-storage";
import type { TablesService } from "@party-stack/ontology-storage/tables";
import type { CollectionConfig, DbClient, LoadSubsetOptions } from "@tanstack/db";

interface Change<A> {
    readonly key: Key;
    readonly type: "insert" | "update" | "delete";
    readonly modified: A;
}
// A present primary-key row is a complete answer, unlike an empty filtered
// cache. Only reuse rows held by another successfully acquired live demand.
function lookupKeys(subset: LoadSubsetOptions, primaryKey: string | undefined): readonly Key[] | undefined {
    if (!primaryKey || subset.offset || subset.cursor || subset.where?.type !== "func") return;
    const { name, args } = subset.where;
    const field = (value: IR.BasicExpression | undefined) =>
        value?.type === "ref" &&
        IR.getPropRefPropertyPath(value).length === 1 &&
        IR.getPropRefPropertyPath(value)[0] === primaryKey;
    const key = (value: unknown): value is Key =>
        typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
    if (name === "eq") {
        const value = field(args[0]) ? args[1] : field(args[1]) ? args[0] : undefined;
        return value?.type === "val" && key(value.value) ? [value.value] : undefined;
    }
    if (name === "in" && field(args[0]) && args[1]?.type === "val") {
        const values: unknown = args[1].value;
        return Array.isArray(values) && values.every(key) ? values : undefined;
    }
    return;
}
interface RowsBatch<A> {
    readonly reset: boolean;
    readonly rows: readonly { key: Key; value: A }[];
    readonly removed: readonly Key[];
}
interface NativeObservations<A> {
    readonly key: (subset: LoadSubsetOptions) => string;
    readonly revision: Effect.Effect<number, unknown>;
    readonly observe: (
        subset: LoadSubsetOptions
    ) => Stream.Stream<RowsBatch<A> & { readonly revision: number }, unknown>;
}
interface PersistedCollectionOptions<A extends object, K extends Key> {
    readonly id: string;
    readonly getKey: (value: A) => K;
    readonly primaryKey?: string;
    readonly load:
        | Effect.Effect<readonly { key: Key; value: A }[], unknown>
        | ((subset: LoadSubsetOptions) => Effect.Effect<readonly { key: Key; value: A }[], unknown>);
    readonly changes: Stream.Stream<void>;
    readonly observe?: (subset: LoadSubsetOptions) => Stream.Stream<
        {
            readonly reset: boolean;
            readonly rows: readonly { key: Key; value: A }[];
            readonly removed: readonly Key[];
        },
        unknown
    >;
    readonly persist?: (mutations: readonly Change<A>[]) => Effect.Effect<void, unknown>;
    readonly acquireDemand?:
        | Effect.Effect<void, unknown, Scope.Scope>
        | ((subset: LoadSubsetOptions) => Effect.Effect<void, unknown, Scope.Scope>);
    readonly describeSubset?: (subset: LoadSubsetOptions) => Omit<CollectionDemandDiagnostic, "subscription">;
    /** Compare the regions actually acquired by this source, after residual
     * filters/order have widened them. No inference from cached row contents.
     */
    readonly covers?: (requested: LoadSubsetOptions, held: LoadSubsetOptions) => boolean;
    readonly supportsOrderedWindow?: (subset: LoadSubsetOptions) => boolean;
}
/** Options creators are Effects: their callback fibers and subscriptions belong to the caller's scope. */
export const persistedCollectionOptions = <A extends object, K extends Key>(
    options: PersistedCollectionOptions<A, K>
) => collectionOptionsImpl(options);
const collectionOptionsImpl = Effect.fnUntraced(function* <A extends object, K extends Key>(
    options: PersistedCollectionOptions<A, K>,
    native?: NativeObservations<A>
) {
    const observing = options.observe !== undefined || native !== undefined;
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<never>();
    let active = true;
    yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
            active = false;
        })
    );
    const run = <B, E>(effect: Effect.Effect<B, E>, owner = scope) =>
        !active || owner.state._tag === "Closed"
            ? Promise.reject(new Error("Collection scope is closed."))
            : Effect.runPromiseWith(context)(
                  Effect.flatMap(Effect.forkIn(effect, owner, { startImmediately: observing }), Fiber.join)
              );
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
              // as soon as the transaction settles.
              await refresh?.();
          }
        : () => Promise.reject(new Error("This collection is read-only. Use ontology actions to mutate it."));
    const config: CollectionConfig<A, K> = {
        id: options.id,
        getKey: options.getKey,
        defaultIndexType: BasicIndex,
        autoIndex: "eager",
        defaultStringCollation: { stringSort: "lexical" },
        syncMode: "on-demand",
        startSync: true,
        onInsert: persist,
        onUpdate: persist,
        onDelete: persist,
        sync: {
            rowUpdateMode: "full",
            supportsOrderedWindow: options.supportsOrderedWindow,
            sync: ({ begin, write, commit, markReady, fail, collection }) => {
                const runScope = Effect.runSync(Scope.fork(scope));
                let alive = true;
                let tail: Promise<void> | undefined;
                const releasing = new Set<Promise<void>>();
                interface Demand {
                    scope: Scope.Closeable;
                    ready: Promise<void>;
                    available: Deferred.Deferred<void>;
                    subset: LoadSubsetOptions;
                    release: () => void;
                    rows: Map<Key, A>;
                    received: boolean;
                    settled: boolean;
                    observed: Deferred.Deferred<void, unknown>;
                    keys?: readonly Key[];
                    requiredRevision?: number;
                    group?: Observation;
                }
                interface Observation {
                    key: string;
                    scope: Scope.Closeable;
                    rows: Map<Key, A>;
                    revision?: number;
                    members: Set<Demand>;
                }
                const demands = new Map<LoadSubsetOptions, Demand>();
                const observations = new Map<string, Observation>();
                const releaseDiagnostics = options.describeSubset
                    ? registerCollectionDemands(collection, () =>
                          [...demands.values()].map(({ subset, received, settled }) => ({
                              ...options.describeSubset!(subset),
                              subscription: subset.subscription,
                              received,
                              ready: settled,
                          }))
                      )
                    : undefined;
                const codec = Table.make<A>({ name: "collection-value" });
                // Diagnostic rows can include typed Error instances. Their display
                // values need no storage codec; conservatively rewrite such rows.
                const fingerprint = (value: A): string | undefined => {
                    try {
                        return codec.encode(value);
                    } catch {
                        return undefined;
                    }
                };
                // Reload keeps the previous rows. Reconcile against those keys
                // rather than inserting them a second time in the new sync run.
                const installed = new Map<Key, string | undefined>(
                    [...collection.entries()].map(([key, value]) => [key, fingerprint(value)])
                );
                const dirtyKeys = new Set<Key>();
                let reconcileInstalled = installed.size > 0;
                const stop = (error: unknown) => {
                    if (!alive || !active) return;
                    alive = false;
                    fail(error);
                    for (const demand of demands.values()) demand.release();
                    const closing = Effect.runPromise(Scope.close(runScope, Exit.void));
                    releasing.add(closing);
                    void closing.finally(() => releasing.delete(closing)).catch(() => undefined);
                };
                const writeRows = async (rows: ReadonlyMap<Key, A>, changed?: ReadonlySet<Key>) => {
                    if (!active || !alive) return;
                    const stale = new Set<Key>();
                    for (const key of changed ?? installed.keys())
                        if (installed.has(key) && !rows.has(key)) stale.add(key);
                    const candidates = changed
                        ? [...changed].flatMap((key) =>
                              rows.has(key) ? [[key, rows.get(key)!] as const] : []
                          )
                        : [...rows];
                    const updates = candidates.filter(([key, value]) => {
                        const encoded = fingerprint(value);
                        return encoded === undefined || installed.get(key) !== encoded;
                    });
                    // A reload can receive its demanded subsets independently.
                    // Keep the old rows until every active subset has a first batch.
                    if (observing && [...demands.values()].some((demand) => !demand.received)) {
                        if (stale.size) reconcileInstalled = true;
                        stale.clear();
                    } else if (reconcileInstalled) {
                        for (const key of installed.keys()) if (!rows.has(key)) stale.add(key);
                        reconcileInstalled = false;
                    }
                    if (!updates.length && !stale.size) return;
                    begin();
                    for (const [key, value] of updates)
                        write({ type: installed.has(key) ? "update" : "insert", value });
                    for (const key of stale) write({ type: "delete", key: key as K });
                    const receipt = commit();
                    await whenSyncAccepted(receipt);
                    for (const key of stale) installed.delete(key);
                    for (const [key, value] of updates) installed.set(key, fingerprint(value));
                };
                const load = () => {
                    const work = async () => {
                        if (!active || !alive) return;
                        // Observation batches identify every key whose winning
                        // demand can change. Take this work before awaiting a
                        // commit so concurrent batches stay queued for next time.
                        const changed = observing ? new Set(dirtyKeys) : undefined;
                        dirtyKeys.clear();
                        const rows = new Map<Key, A>();
                        if (observing) {
                            for (const demand of demands.values()) {
                                if (!demand.received) continue;
                                for (const [key, value] of demand.rows) rows.set(key, value);
                            }
                        } else {
                            if (typeof options.load !== "function")
                                for (const row of await run(options.load)) rows.set(row.key, row.value);
                            for (const [key, demand] of demands) {
                                if (typeof options.load !== "function") break;
                                const loaded = await run(options.load(demand.subset));
                                if (demands.get(key) !== demand) continue;
                                for (const row of loaded) rows.set(row.key, row.value);
                            }
                        }
                        await writeRows(rows, changed);
                    };
                    // Start an idle publisher in this turn. Its first sync commit
                    // can install a native memory snapshot before a query reads it.
                    // Reserve the queue slot first: commit can acquire more demand
                    // reentrantly, which must still publish in FIFO order.
                    let start!: () => void;
                    const next = new Promise<void>((resolve, reject) => {
                        start = () => {
                            void work().then(resolve, reject);
                        };
                    });
                    const previous = tail;
                    tail = next;
                    const finish = () => {
                        if (tail === next) tail = undefined;
                    };
                    void next.then(finish, finish);
                    if (previous) void previous.then(start, start);
                    else if (observing) start();
                    else void Promise.resolve().then(start);
                    return next;
                };
                const close = (owner: Scope.Closeable) => {
                    const closing = Effect.runPromise(Scope.close(owner, Exit.void));
                    releasing.add(closing);
                    void closing.then(
                        () => releasing.delete(closing),
                        (error) => {
                            releasing.delete(closing);
                            stop(error);
                        }
                    );
                };
                const publishObservation = async (
                    group: Observation,
                    batch?: RowsBatch<A> & { readonly revision: number }
                ) => {
                    if (!alive || !active || observations.get(group.key) !== group) return;
                    let changed = false;
                    if (batch) {
                        if (batch.reset) {
                            for (const key of group.rows.keys()) dirtyKeys.add(key);
                            changed = group.rows.size > 0;
                            group.rows.clear();
                        }
                        for (const key of batch.removed) {
                            if (!group.rows.delete(key)) continue;
                            dirtyKeys.add(key);
                            changed = true;
                        }
                        for (const row of batch.rows) {
                            dirtyKeys.add(row.key);
                            group.rows.set(row.key, row.value);
                            changed = true;
                        }
                        // Admission must see this before load(): a DB commit can
                        // acquire another identical include synchronously.
                        group.revision = batch.revision;
                    }
                    let admitted = false;
                    for (const member of group.members) {
                        if (
                            member.received ||
                            group.revision === undefined ||
                            group.revision < member.requiredRevision!
                        )
                            continue;
                        member.received = true;
                        admitted = true;
                        // The new logical demand can change overlap precedence.
                        for (const key of group.rows.keys()) dirtyKeys.add(key);
                    }
                    const published = [...group.members].filter((member) => member.received);
                    if (changed || admitted || reconcileInstalled) await load();
                    for (const member of published) {
                        if (!alive || !active || !group.members.has(member)) continue;
                        if (member.keys?.every((key) => group.rows.has(key)))
                            Effect.runSync(Deferred.succeed(member.available, undefined));
                        Effect.runSync(Deferred.succeed(member.observed, undefined));
                    }
                };
                const observeNative = Effect.fnUntraced(function* (demand: Demand) {
                    const revision = yield* native!.revision;
                    const joined = yield* Effect.uninterruptible(
                        Effect.gen(function* () {
                            if (demands.get(demand.subset) !== demand) return;
                            const key = native!.key(demand.subset);
                            let group = observations.get(key);
                            const created = !group;
                            if (!group) {
                                // Lookup, allocation and registration are one synchronous
                                // operation, including under cooperative Effect scheduling.
                                group = {
                                    key,
                                    scope: Scope.forkUnsafe(runScope),
                                    rows: new Map(),
                                    members: new Set(),
                                };
                                observations.set(key, group);
                            }
                            const current = group;
                            demand.rows = current.rows;
                            demand.requiredRevision = revision;
                            demand.group = current;
                            current.members.add(demand);
                            if (created) {
                                yield* Stream.runForEach(native!.observe(demand.subset), (batch) =>
                                    Effect.tryPromise({
                                        try: () => publishObservation(current, batch),
                                        catch: (cause) => cause,
                                    }).pipe(
                                        Effect.withSpan("Ontology.collection.publish", {
                                            attributes: {
                                                collection: options.id,
                                                rows: batch.rows.length,
                                                removed: batch.removed.length,
                                                reset: batch.reset,
                                            },
                                        })
                                    )
                                ).pipe(
                                    Effect.catch((error) =>
                                        Effect.sync(() => {
                                            if (observations.get(key) !== current) return;
                                            for (const member of current.members)
                                                Effect.runSync(Deferred.fail(member.observed, error));
                                            stop(error);
                                        })
                                    ),
                                    Effect.interruptible,
                                    Effect.forkIn(current.scope, { startImmediately: true })
                                );
                            }
                            // Only registration is uninterruptible. The shared observer
                            // belongs to its own scope before the first caller can leave.
                            return { current, created };
                        })
                    );
                    if (!joined) return;
                    const { current, created } = joined;
                    if (!created && current.revision !== undefined && current.revision >= revision) {
                        yield* Effect.tryPromise({
                            try: () => publishObservation(current),
                            catch: (cause) => cause,
                        });
                    }
                    yield* Deferred.await(demand.observed);
                });
                refresh = load;
                const watcher = run(
                    Effect.forkIn(
                        Stream.runForEach(observing ? Stream.empty : options.changes, () =>
                            queried && (demands.size || typeof options.load !== "function")
                                ? Effect.tryPromise({ try: load, catch: (cause) => cause })
                                : Effect.void
                        ).pipe(
                            Effect.catch((error) =>
                                Effect.sync(() => {
                                    stop(error);
                                })
                            )
                        ),
                        runScope,
                        { startImmediately: true }
                    ),
                    runScope
                );
                markReady();
                return {
                    loadSubset: (subset) => {
                        if (subset.signal?.aborted) return Promise.resolve();
                        queried = true;
                        const keys = lookupKeys(subset, options.primaryKey);
                        // A completed, still-held collection demand is a completeness
                        // witness for every local filter/window, including empty results.
                        const wholeCollection = [...demands.values()].some(
                            (demand) =>
                                demand.settled &&
                                !demand.subset.where &&
                                demand.subset.limit === undefined &&
                                !demand.subset.offset &&
                                !demand.subset.cursor
                        );
                        let cached =
                            wholeCollection ||
                            [...demands.values()].some(
                                (demand) => demand.settled && options.covers?.(subset, demand.subset)
                            ) ||
                            (keys &&
                                keys.every(
                                    (key) =>
                                        collection.has(key as K) &&
                                        [...demands.values()].some(
                                            (demand) => demand.settled && demand.rows.has(key)
                                        )
                                ));
                        // Each acquisition has its own immutable options, signal
                        // and matching unload, even for equivalent queries.
                        const key = subset;
                        let demand = demands.get(key);
                        if (!demand) {
                            if (!demands.size) reconcileInstalled = true;
                            const child = Effect.runSync(Scope.fork(runScope));
                            const acquire = options.acquireDemand;
                            demand = {
                                scope: child,
                                subset,
                                rows: new Map(),
                                received: false,
                                settled: false,
                                ready: Promise.resolve(),
                                available: Effect.runSync(Deferred.make<void>()),
                                observed: Effect.runSync(Deferred.make<void, unknown>()),
                                keys,
                                release: () => {
                                    subset.signal?.removeEventListener("abort", demand!.release);
                                    if (!demand || demands.get(key) !== demand) return;
                                    if (demand.received)
                                        for (const rowKey of demand.rows.keys()) dirtyKeys.add(rowKey);
                                    demands.delete(key);
                                    const group = demand.group;
                                    group?.members.delete(demand);
                                    if (group && !group.members.size) {
                                        observations.delete(group.key);
                                        close(group.scope);
                                    }
                                    close(child);
                                    if (alive && active && demands.size) void load().catch(stop);
                                },
                            };
                            demands.set(key, demand);
                            subset.signal?.addEventListener("abort", demand.release, { once: true });
                            demand.ready = run(
                                Scope.provide(
                                    Effect.gen(function* () {
                                        const acquisition =
                                            typeof acquire === "function" ? acquire(subset) : acquire;
                                        // Observe installed rows while readiness is pending. Cached
                                        // data is displayable; it does not mean remote demand is ready.
                                        const acquiring =
                                            observing && acquisition
                                                ? yield* Effect.forkIn(acquisition, child, {
                                                      startImmediately: true,
                                                  })
                                                : undefined;
                                        if (!observing && acquisition) yield* acquisition;
                                        if (native) {
                                            const observed = yield* Effect.forkIn(
                                                observeNative(demand!),
                                                child,
                                                {
                                                    startImmediately: true,
                                                }
                                            );
                                            yield* Effect.all(
                                                [
                                                    Fiber.join(observed),
                                                    ...(acquiring ? [Fiber.join(acquiring)] : []),
                                                ],
                                                { concurrency: "unbounded", discard: true }
                                            );
                                        } else if (options.observe) {
                                            const ready = yield* Deferred.make<void, unknown>();
                                            yield* Stream.runForEach(options.observe(subset), (batch) =>
                                                Effect.tryPromise({
                                                    try: async () => {
                                                        if (!demand || demands.get(key) !== demand) return;
                                                        const first = !demand.received;
                                                        let changed = false;
                                                        demand.received = true;
                                                        if (batch.reset) {
                                                            for (const rowKey of demand.rows.keys()) {
                                                                dirtyKeys.add(rowKey);
                                                                changed = true;
                                                            }
                                                            demand.rows.clear();
                                                        }
                                                        for (const removed of batch.removed) {
                                                            // Native observers conservatively report keys
                                                            // outside their filter. Only a key contributed
                                                            // by this demand can change its winning row.
                                                            if (!demand.rows.delete(removed)) continue;
                                                            dirtyKeys.add(removed);
                                                            changed = true;
                                                        }
                                                        for (const row of batch.rows) {
                                                            dirtyKeys.add(row.key);
                                                            demand.rows.set(row.key, row.value);
                                                            changed = true;
                                                        }
                                                        if (first || changed || reconcileInstalled)
                                                            await load();
                                                        // An optimistic insert can arrive after a point read
                                                        // starts. Its positive result is already known locally;
                                                        // only absence needs completed upstream coverage.
                                                        if (keys?.every((key) => demand!.rows.has(key)))
                                                            Effect.runSync(
                                                                Deferred.succeed(demand.available, undefined)
                                                            );
                                                        Effect.runSync(Deferred.succeed(ready, undefined));
                                                    },
                                                    catch: (cause) => cause,
                                                }).pipe(
                                                    Effect.withSpan("Ontology.collection.publish", {
                                                        attributes: {
                                                            collection: options.id,
                                                            rows: batch.rows.length,
                                                            removed: batch.removed.length,
                                                            reset: batch.reset,
                                                        },
                                                    })
                                                )
                                            ).pipe(
                                                Effect.catch((error) =>
                                                    Effect.gen(function* () {
                                                        yield* Deferred.fail(ready, error);
                                                        if (alive && active && demands.get(key) === demand)
                                                            stop(error);
                                                    })
                                                ),
                                                Effect.forkIn(child, { startImmediately: true })
                                            );
                                            yield* Effect.all(
                                                [
                                                    Deferred.await(ready),
                                                    ...(acquiring ? [Fiber.join(acquiring)] : []),
                                                ],
                                                { concurrency: "unbounded", discard: true }
                                            );
                                        }
                                    }),
                                    child
                                ),
                                child
                            );
                            void demand.ready.catch((error) => {
                                if (
                                    (cached || demand!.settled) &&
                                    demands.get(key) === demand &&
                                    !subset.signal?.aborted
                                )
                                    stop(error);
                                demand!.release();
                            });
                        }
                        const current = demand;
                        // A synchronous first snapshot can answer a positive
                        // point read immediately. Absence still waits for upstream
                        // coverage, and the scoped acquisition reports late errors.
                        cached ||= Boolean(
                            keys?.every((key) => current.rows.has(key) && collection.has(key as K))
                        );
                        // Reusing rows or coverage never bypasses the new lease's
                        // local revision fence, including a complete empty answer.
                        if (native && !current.received) cached = false;
                        const completed = Promise.race([
                            current.ready,
                            ...(keys ? [run(Deferred.await(current.available), current.scope)] : []),
                        ]).then(async () => {
                            await load();
                            current.settled = true;
                        });
                        if (cached) {
                            // Keep the scoped observer/lease and report later failures normally;
                            // readiness needn't wait for another acquisition of a known row.
                            void completed.catch((error) => {
                                if (demands.get(key) === current && !subset.signal?.aborted) stop(error);
                            });
                            return true;
                        }
                        return completed;
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
                        observations.clear();
                        dirtyKeys.clear();
                        await Effect.runPromise(Scope.close(runScope, Exit.void));
                    },
                };
            },
        },
    };
    return config;
});
// Local collection clients share the owning tables service, never another context's tables.
const localListeners = new WeakMap<TablesService, Set<() => void>>();
const localChanges = (tables: TablesService) => {
    let listeners = localListeners.get(tables);
    if (!listeners) localListeners.set(tables, (listeners = new Set()));
    const current = listeners;
    return {
        changes: Stream.callback<void>(
            (queue) =>
                Effect.acquireRelease(
                    Effect.sync(() => {
                        const listener = () => {
                            Queue.offerUnsafe(queue, undefined);
                        };
                        current.add(listener);
                        return listener;
                    }),
                    (listener) =>
                        Effect.sync(() => {
                            current.delete(listener);
                        })
                ),
            { bufferSize: 1, strategy: "sliding" }
        ),
        notify: Effect.sync(() => {
            for (const listener of current) listener();
        }),
    };
};
export const localCollectionOptions = Effect.fnUntraced(function* <A extends object, K extends Key>(options: {
    readonly name: string;
    readonly getKey: (value: A) => K;
    readonly schemaVersion?: number;
}) {
    const runtime = yield* Runtime;
    const local = localChanges(runtime.tables);
    const table = Table.make<A>({
        name: JSON.stringify(["local", runtime.owner, runtime.namespace, options.name]),
        version: options.schemaVersion,
    });
    const config = yield* persistedCollectionOptions<A, K>({
        id: `party-stack:${runtime.owner}:${runtime.namespace}:${options.name}`,
        getKey: options.getKey,
        load: (subset) => runtime.tables.query(table, storageSubset(subset)),
        changes: local.changes,
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
                .pipe(Effect.tap(() => local.notify)),
    });
    return config;
});
export const replicatedCollectionOptions = Effect.fnUntraced(function* <A extends object>(options: {
    readonly replica: ReplicaService;
    readonly objectType: string;
    readonly getKey: (value: A) => Key;
    readonly id: string;
    /** Observe and retain local cache only; never acquire upstream demand. */
    readonly localOnly?: boolean;
}) {
    const subsetCodec = Table.make({ name: "native-observation-subset" });
    const revision = readVisibleRevision(options.replica);
    const observe = (subset: LoadSubsetOptions) =>
        options.replica.observeSubset(ontologySubset(subset, options.replica.ir, options.objectType)).pipe(
            Stream.map((batch) => ({
                ...batch,
                rows: batch.rows.map((row) => ({ key: row.key, value: row.value as A })),
            }))
        );
    return yield* collectionOptionsImpl<A, Key>(
        {
            id: options.id,
            getKey: options.getKey,
            primaryKey: options.replica.ir.objectTypes.find((type) => type.name === options.objectType)
                ?.primaryKey,
            supportsOrderedWindow: (subset) =>
                analyzeOntologySubset(subset, options.replica.ir, options.objectType).orderedWindowExact,
            covers: (requested, held) =>
                coversSubset(
                    {
                        objectType: options.objectType,
                        query: storageSubset(requested, options.replica.ir, options.objectType),
                    },
                    {
                        objectType: options.objectType,
                        query: storageSubset(held, options.replica.ir, options.objectType),
                    }
                ),
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
                    options.replica.readSubset(
                        ontologySubset(subset, options.replica.ir, options.objectType)
                    ),
                    (rows) =>
                        rows.map((row) => ({
                            key: row.key,
                            value: row.value as A,
                        }))
                ),
            changes: Stream.empty,
            observe,
            acquireDemand: (subset) =>
                options.localOnly
                    ? options.replica.demand.acquire(
                          ontologySubset(subset, options.replica.ir, options.objectType),
                          { localOnly: true }
                      )
                    : options.replica.demand.acquire(
                          ontologySubset(subset, options.replica.ir, options.objectType)
                      ),
        },
        revision
            ? {
                  key: (subset) =>
                      subsetCodec.encode(ontologySubset(subset, options.replica.ir, options.objectType)),
                  revision,
                  observe,
              }
            : undefined
    );
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
                      await collection.cleanup({ dependents: true });
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
