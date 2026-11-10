import { clientRegistry } from "@party-stack/ontology-backend/clients";
import { makeOwnedBackend, type OwnedTransaction } from "@party-stack/ontology-backend/owned";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Effect, Exit, Scope, Stream } from "effect";
import { expect, test } from "vitest";
import { makeReplica, replicaStateSource } from "./testing.js";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Counter",
            displayName: "Counter",
            pluralDisplayName: "Counters",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "count", displayName: "Count", type: o.integer({}) },
            ],
        },
    ],
    actionTypes: [{ name: "increment", displayName: "Increment", parameters: [], logic: [] }],
};
const increment = Effect.fnUntraced(function* (tx: OwnedTransaction) {
    const row = yield* tx.get("Counter", "one");
    yield* tx.put("Counter", { id: "one", count: Number(row?.count ?? 0) + 1 });
});
const until = Effect.fnUntraced(function* <E>(condition: Effect.Effect<boolean, E>) {
    while (!(yield* condition)) yield* Effect.sleep(1);
}, Effect.timeout("5 seconds"));

test("delivery owner loss rebuilds the view while preserving accepted actions and client watermarks", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let executions = 0;
                const authority = yield* makeOwnedBackend({
                    namespace: "owner-loss-authority",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: {
                        increment: (tx) =>
                            Effect.gen(function* () {
                                executions++;
                                yield* increment(tx);
                            }),
                    },
                });
                yield* authority.applyAction({ id: "seed", name: "increment", parameters: {} });
                executions = 0;
                const tables = yield* Memory.make();
                const options = {
                    namespace: "owner-loss-parent",
                    ir,
                    tables,
                    backend: authority,
                    execute: increment,
                    startSync: false,
                    objectCacheGc: false as const,
                };
                const owner = yield* Effect.scope;
                const firstScope = yield* Scope.fork(owner);
                let parent = yield* Scope.provide(makeReplica(options), firstScope);
                const firstParent = parent;
                const sourceId = parent.sourceId;
                yield* Scope.provide(parent.demand({ objectType: "Counter" }), firstScope);
                yield* parent.syncOnce;
                const accepted = yield* Deferred.make<void>();
                const rebuilt = yield* Deferred.make<void>();
                let restarted = false;
                let expiredViews = 0;
                let snapshotsAfterRestart = 0;
                let replacement: Deferred.Deferred<void> | undefined;
                const currentParent = Effect.gen(function* () {
                    // A route acquires its new owner before exposing native methods.
                    // The closed owner's InvalidRequest is not a transport error.
                    const ready = replacement;
                    if (ready) yield* Deferred.await(ready);
                    return parent;
                });
                const source: OntologySource = {
                    sourceId,
                    supportsIdempotency: true,
                    openClient: (resume) =>
                        Effect.flatMap(currentParent, (owner) => owner.openClient(resume)),
                    read: (session, view) =>
                        Effect.flatMap(currentParent, (owner) => owner.readClient(session, view)),
                    subscribe: (session, view, policy, resume) =>
                        Effect.gen(function* () {
                            const producer = yield* currentParent;
                            const subscription = yield* producer
                                .subscribeClient(session, view, policy, resume)
                                .pipe(
                                    Effect.tapError((error) =>
                                        Effect.sync(() => {
                                            if (error.kind === "HistoryExpired") expiredViews++;
                                        })
                                    )
                                );
                            return {
                                ...subscription,
                                frames: subscription.frames.pipe(
                                    Stream.tapError((error) =>
                                        Effect.sync(() => {
                                            if (error.kind === "HistoryExpired") expiredViews++;
                                        })
                                    ),
                                    Stream.tap((frame) =>
                                        Effect.gen(function* () {
                                            if (
                                                restarted &&
                                                producer === parent &&
                                                producer !== firstParent &&
                                                frame.kind === "snapshot" &&
                                                frame.end
                                            ) {
                                                snapshotsAfterRestart++;
                                                yield* Deferred.succeed(rebuilt, undefined);
                                            }
                                        })
                                    )
                                ),
                            };
                        }),
                    acknowledgeDelivery: (position) =>
                        Effect.flatMap(currentParent, (owner) => owner.acknowledgeDelivery(position)),
                    accept: (request) =>
                        Effect.gen(function* () {
                            yield* Effect.flatMap(currentParent, (owner) => owner.acceptClient(request));
                            yield* Deferred.succeed(accepted, undefined);
                        }),
                    demand: (subset) =>
                        Stream.unwrap(
                            Effect.map(currentParent, (owner) => replicaStateSource(owner).demand(subset))
                        ),
                    subscribeChanges: Effect.flatMap(currentParent, (owner) => owner.subscribeChanges),
                    submit: (request) =>
                        Effect.flatMap(currentParent, (owner) => owner.submitClient(request)),
                    acknowledge: (session, revision, through, generation) =>
                        Effect.flatMap(currentParent, (owner) =>
                            owner.acknowledgeClient(session, revision, through, generation)
                        ),
                };
                // The live child uses the real incremental connection. The parent
                // remains manually dispatched so its accepted work is still pending.
                const child = yield* makeReplica({
                    namespace: "owner-loss-child",
                    ir,
                    tables: yield* Memory.make(),
                    source,
                    execute: increment,
                    objectCacheGc: false,
                });
                yield* child.demand({ objectType: "Counter" });
                yield* child.retainActions(["owner-write"]);
                yield* until(Effect.map(child.confirmed.get("Counter", "one"), (row) => row?.count === 1));
                yield* child.enqueue({ id: "owner-write", name: "increment", parameters: {} });
                yield* Deferred.await(accepted);
                expect((yield* parent.pending).map((action) => action.invocation.id)).toEqual([
                    "owner-write",
                ]);
                expect(executions).toBe(0);
                const clients = clientRegistry(options.namespace, sourceId);
                const before = yield* tables.query(clients.clients);
                expect(before).toHaveLength(1);
                expect(before[0]?.value.acceptedThrough).toBe(1);

                const expiredBeforeRestart = expiredViews;
                replacement = yield* Deferred.make<void>();
                restarted = true;
                yield* Scope.close(firstScope, Exit.void);
                const secondScope = yield* Scope.fork(owner);
                parent = yield* Scope.provide(makeReplica(options), secondScope);
                yield* Deferred.succeed(replacement, undefined);
                replacement = undefined;
                expect(parent.sourceId).toBe(sourceId);
                expect((yield* parent.pending).map((action) => action.invocation.id)).toEqual([
                    "owner-write",
                ]);
                yield* Deferred.await(rebuilt).pipe(Effect.timeout("5 seconds"));
                yield* until(
                    Effect.map(child.parentState, (state) =>
                        Boolean(state?.pending.some((action) => action.invocation.id === "owner-write"))
                    )
                );
                expect(expiredViews).toBeGreaterThan(expiredBeforeRestart);
                expect(snapshotsAfterRestart).toBeGreaterThan(0);
                expect(executions).toBe(0);
                expect((yield* child.get("Counter", "one"))?.count).toBe(2);
                expect((yield* child.confirmed.get("Counter", "one"))?.count).toBe(1);
                expect(yield* child.receipt("owner-write")).toBeUndefined();

                yield* parent.syncOnce;
                yield* until(
                    Effect.map(child.receipt("owner-write"), (receipt) => receipt?.outcome === "committed")
                );
                yield* until(Effect.map(parent.pending, (actions) => actions.length === 0));
                yield* until(Effect.map(child.pending, (actions) => actions.length === 0));
                yield* until(Effect.map(child.confirmed.get("Counter", "one"), (row) => row?.count === 2));
                yield* until(
                    Effect.map(
                        tables.query(clients.clients),
                        (records) => records.length === 1 && records[0]?.value.acknowledgedThrough === 1
                    )
                );
                expect(executions).toBe(1);
                expect(yield* parent.pending).toEqual([]);
                expect(yield* child.pending).toEqual([]);
                expect((yield* child.confirmed.get("Counter", "one"))?.count).toBe(2);
                const after = yield* tables.query(clients.clients);
                expect(after).toHaveLength(1);
                expect(after[0]?.key).toBe(before[0]?.key);
                expect(after[0]?.value.acceptedThrough).toBe(1);
                expect(after[0]?.value.acknowledgedThrough).toBe(1);
            })
        )
    );
});
