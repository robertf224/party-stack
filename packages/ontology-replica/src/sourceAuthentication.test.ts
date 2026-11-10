import { it } from "@effect/vitest";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Clock, Deferred, Effect, Exit, Fiber, PubSub, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { makeReplica, replicaStateSource } from "./testing.js";
import type { ConnectionState } from "@party-stack/connect";
import type { OwnedTransaction } from "@party-stack/ontology-backend/owned";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";
import type { OntologyIR } from "@party-stack/ontology-spec";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "count", displayName: "Count", type: o.integer({}) },
            ],
        },
    ],
    actionTypes: [{ name: "write", displayName: "Write", parameters: [], logic: [] }],
};
const execute = (tx: OwnedTransaction) => tx.put("Item", { id: "one", count: 2 });
const subset = { objectType: "Item" };

for (const mode of ["delivery", "snapshot"] as const)
    it.effect(`${mode} opens cached data while initially signed out and resumes only on authentication`, () =>
        Effect.scoped(
            Effect.gen(function* () {
                const authority = yield* makeOwnedBackend({
                    ir,
                    namespace: `source-auth-authority-${mode}`,
                    tables: yield* Memory.make(),
                    mutators: {},
                });
                yield* authority.storage.transaction((tx) => tx.put("Item", { id: "one", count: 1 }));
                const parent = yield* makeReplica({
                    ir,
                    namespace: `source-auth-parent-${mode}`,
                    tables: yield* Memory.make(),
                    backend: authority,
                    execute,
                    live: false,
                    startSync: false,
                    objectCacheGc: false,
                });
                yield* parent.demand(subset);
                yield* parent.syncOnce;
                const original = replicaStateSource(parent);
                const accepted = yield* Deferred.make<void>();
                const calls = { open: 0, subscribe: 0, changes: 0, demand: 0, read: 0, accept: 0, submit: 0 };
                const count = <A, E, R>(key: keyof typeof calls, effect: Effect.Effect<A, E, R>) =>
                    Effect.sync(() => {
                        calls[key]++;
                    }).pipe(Effect.andThen(effect));
                const source: OntologySource = {
                    ...original,
                    openClient: (...args) => count("open", original.openClient(...args)),
                    read: (...args) => count("read", original.read(...args)),
                    subscribe:
                        mode === "delivery"
                            ? (...args) => count("subscribe", original.subscribe!(...args))
                            : undefined,
                    subscribeChanges: count("changes", original.subscribeChanges),
                    demand: (request) =>
                        Stream.unwrap(count("demand", Effect.succeed(original.demand(request)))),
                    accept: (request) =>
                        count("accept", original.accept!(request)).pipe(
                            Effect.tap(() => Deferred.succeed(accepted, undefined))
                        ),
                    submit: (request) =>
                        count("submit", original.submit(request)).pipe(
                            Effect.tap(() => Deferred.succeed(accepted, undefined))
                        ),
                };
                const tables = yield* Memory.make();
                const namespace = `source-auth-child-${mode}`;
                const warmScope = yield* Scope.fork(yield* Effect.scope);
                const warm = yield* makeReplica({
                    ir,
                    namespace,
                    tables,
                    source,
                    execute,
                    startSync: false,
                    objectCacheGc: false,
                }).pipe(Scope.provide(warmScope));
                yield* warm.demand(subset).pipe(Scope.provide(warmScope));
                yield* warm.refreshParent(source);
                expect(yield* warm.confirmed.get("Item", "one")).toEqual({ id: "one", count: 1 });
                yield* Scope.close(warmScope, Exit.void);
                for (const key of Object.keys(calls) as (keyof typeof calls)[]) calls[key] = 0;

                let state: ConnectionState = { status: "needs-auth" };
                const events = yield* PubSub.sliding<ConnectionState>({ capacity: 1, replay: 1 });
                yield* Effect.addFinalizer(() => PubSub.shutdown(events));
                yield* PubSub.publish(events, state);
                const child = yield* makeReplica({
                    ir,
                    namespace,
                    tables,
                    source,
                    execute,
                    objectCacheGc: false,
                    // This source is a local persistent owner: physical connectivity
                    // must not prevent forwarding after authentication becomes active.
                    connectivity: { online: Effect.succeed(false), changes: Stream.never },
                    connection: {
                        get state() {
                            return state;
                        },
                        changes: Stream.fromPubSub(events),
                    },
                });
                yield* child.demand(subset);
                yield* child.syncSubset(subset, { resultType: "cached" });
                expect(yield* child.confirmed.get("Item", "one")).toEqual({ id: "one", count: 1 });
                const fresh = yield* child.syncSubset(subset).pipe(Effect.forkScoped);
                yield* child.enqueue({ id: "paused-write", name: "write", parameters: {} });
                expect(yield* child.loadSubset("Item")).toEqual([
                    { key: "one", value: { id: "one", count: 2 } },
                ]);
                yield* child.refreshParent(source);
                yield* child.forwardParentActions(source);
                const now = yield* Clock.currentTimeMillis;
                yield* TestClock.adjust(60_000);
                expect(calls).toEqual({
                    open: 0,
                    subscribe: 0,
                    changes: 0,
                    demand: 0,
                    read: 0,
                    accept: 0,
                    submit: 0,
                });
                expect(yield* child.pending).toMatchObject([{ state: "queued", attempts: 0 }]);
                expect(fresh.pollUnsafe()).toBeUndefined();

                state = { status: "active" };
                yield* PubSub.publish(events, state);
                yield* Deferred.await(accepted);
                yield* Fiber.join(fresh);
                expect(yield* Clock.currentTimeMillis).toBe(now + 60_000);
                expect((yield* parent.pending).some((entry) => entry.invocation.id === "paused-write")).toBe(
                    true
                );
                expect(calls.open).toBeGreaterThan(0);
                expect(mode === "delivery" ? calls.subscribe : calls.changes).toBeGreaterThan(0);
                expect(calls.accept + calls.submit).toBeGreaterThan(0);
            })
        )
    );
