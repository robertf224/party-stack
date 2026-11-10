import { it } from "@effect/vitest";
import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Clock, Deferred, Effect, Exit, PubSub, Queue, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { connectReplicaDelivery } from "./parent.js";
import { makeReplica, replicaStateSource } from "./testing.js";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";
import type { OntologyIR } from "@party-stack/ontology-spec";

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
    actionTypes: [{ name: "seed", displayName: "Seed", parameters: [], logic: [] }],
};
const expired = () =>
    new BackendError({
        operation: "test.delivery",
        kind: "HistoryExpired",
        retryable: true,
        message: "The producer no longer has the requested view.",
    });

it.effect(
    "lost delivery history rebuilds immediately once, backs off without progress, and rearms after installation",
    () =>
        Effect.scoped(
            Effect.gen(function* () {
                const authority = yield* makeOwnedBackend({
                    namespace: "recovery-authority",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: { seed: (tx) => tx.put("Counter", { id: "one", count: 1 }) },
                });
                yield* authority.applyAction({ id: "seed", name: "seed", parameters: {} });
                const parent = yield* makeReplica({
                    namespace: "recovery-parent",
                    ir,
                    tables: yield* Memory.make(),
                    backend: authority,
                    startSync: false,
                    live: false,
                    objectCacheGc: false,
                    execute: () => Effect.void,
                });
                yield* parent.demand({ objectType: "Counter" });
                yield* parent.syncOnce;
                const actual = replicaStateSource(parent);
                const opened = yield* Queue.unbounded<{ attempt: number; at: number }>();
                const reset = yield* Queue.unbounded<number>();
                const applied = yield* Queue.unbounded<number>();
                const acknowledged = yield* Queue.unbounded<number>();
                const losses = new Map<number, Deferred.Deferred<void>>();
                let attempts = 0;
                let active = 0;
                let closed = 0;
                const source: OntologySource = {
                    ...actual,
                    subscribe: (session, view, policy, resume) =>
                        Effect.gen(function* () {
                            const attempt = ++attempts;
                            yield* Effect.acquireRelease(
                                Effect.sync(() => {
                                    active++;
                                }),
                                () =>
                                    Effect.sync(() => {
                                        active--;
                                        closed++;
                                    })
                            );
                            yield* Queue.offer(opened, { attempt, at: yield* Clock.currentTimeMillis });
                            if (attempt <= 2) return yield* expired();
                            const loss = yield* Deferred.make<void>();
                            losses.set(attempt, loss);
                            const subscription = yield* actual.subscribe!(session, view, policy, resume);
                            return {
                                ...subscription,
                                frames: subscription.frames.pipe(
                                    Stream.merge(
                                        Stream.fromEffect(
                                            Deferred.await(loss).pipe(Effect.andThen(Effect.fail(expired())))
                                        )
                                    )
                                ),
                                acknowledge: (position) =>
                                    subscription
                                        .acknowledge(position)
                                        .pipe(
                                            Effect.andThen(Queue.offer(acknowledged, attempt)),
                                            Effect.asVoid
                                        ),
                            };
                        }),
                };
                const child = yield* makeReplica({
                    namespace: "recovery-child",
                    ir,
                    tables: yield* Memory.make(),
                    source,
                    startSync: false,
                    objectCacheGc: false,
                    execute: () => Effect.void,
                });
                yield* child.demand({ objectType: "Counter" });
                const controller = {
                    ...child,
                    resetParentDelivery: child.resetParentDelivery.pipe(
                        Effect.andThen(Effect.suspend(() => Queue.offer(reset, attempts))),
                        Effect.asVoid
                    ),
                    receiveDelivery: (...args: Parameters<typeof child.receiveDelivery>) =>
                        child
                            .receiveDelivery(...args)
                            .pipe(
                                Effect.tap((installed) =>
                                    installed && !installed.duplicate
                                        ? Queue.offer(applied, attempts).pipe(Effect.asVoid)
                                        : Effect.void
                                )
                            ),
                };
                const owner = yield* Scope.fork(yield* Effect.scope);
                const start = yield* Clock.currentTimeMillis;
                yield* connectReplicaDelivery(controller, source).pipe(Scope.provide(owner));
                expect(yield* Queue.take(opened)).toEqual({ attempt: 1, at: start });
                expect(yield* Queue.take(reset)).toBe(1);
                // Drain runnable fibers without advancing virtual time. The old
                // unconditional retry sleep leaves only one attempt here.
                yield* TestClock.adjust(0);
                expect(attempts).toBe(2);
                expect(yield* Queue.take(opened)).toEqual({ attempt: 2, at: start });
                expect(yield* Queue.take(reset)).toBe(2);
                expect(active).toBe(0);
                expect(closed).toBe(2);
                yield* TestClock.adjust(999);
                expect(attempts).toBe(2);
                yield* TestClock.adjust(1);
                expect(yield* Queue.take(opened)).toEqual({ attempt: 3, at: start + 1_000 });
                expect(yield* Queue.take(applied)).toBe(3);
                expect(yield* Queue.take(acknowledged)).toBe(3);
                expect(yield* child.confirmed.get("Counter", "one")).toEqual({ id: "one", count: 1 });
                // Applied progress earns one more immediate rebuild, including a
                // HistoryExpired failure emitted by an already acquired stream.
                yield* Deferred.succeed(losses.get(3)!, undefined);
                expect(yield* Queue.take(reset)).toBe(3);
                yield* TestClock.adjust(0);
                expect(attempts).toBe(4);
                expect(yield* Queue.take(opened)).toEqual({ attempt: 4, at: start + 1_000 });
                expect(yield* Queue.take(applied)).toBe(4);
                expect(yield* Queue.take(acknowledged)).toBe(4);
                expect(active).toBe(1);
                yield* Scope.close(owner, Exit.void);
                expect(active).toBe(0);
                expect(closed).toBe(4);
            })
        )
);

for (const failureAt of ["semantic", "delivery"] as const)
    it.effect(`repeated ${failureAt} ACK history expiration backs off until an ACK completes`, () =>
        Effect.scoped(
            Effect.gen(function* () {
                const authority = yield* makeOwnedBackend({
                    namespace: `ack-recovery-authority-${failureAt}`,
                    ir,
                    tables: yield* Memory.make(),
                    mutators: { seed: (tx) => tx.put("Counter", { id: "one", count: 1 }) },
                });
                yield* authority.applyAction({ id: "seed", name: "seed", parameters: {} });
                const parent = yield* makeReplica({
                    namespace: `ack-recovery-parent-${failureAt}`,
                    ir,
                    tables: yield* Memory.make(),
                    backend: authority,
                    startSync: false,
                    live: false,
                    objectCacheGc: false,
                    execute: () => Effect.void,
                });
                yield* parent.demand({ objectType: "Counter" });
                yield* parent.syncOnce;
                const actual = replicaStateSource(parent);
                const opened = yield* Queue.unbounded<number>();
                const resets = yield* Queue.unbounded<number>();
                const acknowledged = yield* Queue.unbounded<number>();
                let attempts = 0;
                const source: OntologySource = {
                    ...actual,
                    subscribe: (session, view, policy, resume) =>
                        Effect.gen(function* () {
                            const attempt = ++attempts;
                            yield* Queue.offer(opened, attempt);
                            const subscription = yield* actual.subscribe!(session, view, policy, resume);
                            return {
                                ...subscription,
                                acknowledge: (position) =>
                                    failureAt === "delivery" && attempt <= 2
                                        ? Effect.fail(expired())
                                        : subscription
                                              .acknowledge(position)
                                              .pipe(
                                                  Effect.andThen(Queue.offer(acknowledged, attempt)),
                                                  Effect.asVoid
                                              ),
                            };
                        }),
                    acknowledge: (session, revision, through, generation) =>
                        failureAt === "semantic" && attempts <= 2
                            ? Effect.fail(expired())
                            : actual.acknowledge(session, revision, through, generation),
                };
                const child = yield* makeReplica({
                    namespace: `ack-recovery-child-${failureAt}`,
                    ir,
                    tables: yield* Memory.make(),
                    source,
                    startSync: false,
                    objectCacheGc: false,
                    execute: () => Effect.void,
                });
                yield* child.demand({ objectType: "Counter" });
                const controller = {
                    ...child,
                    resetParentDelivery: child.resetParentDelivery.pipe(
                        Effect.andThen(Effect.suspend(() => Queue.offer(resets, attempts))),
                        Effect.asVoid
                    ),
                };
                const start = yield* Clock.currentTimeMillis;
                yield* connectReplicaDelivery(controller, source);
                expect(yield* Queue.take(opened)).toBe(1);
                expect(yield* Queue.take(resets)).toBe(1);
                expect(yield* Queue.take(opened)).toBe(2);
                expect(yield* Queue.take(resets)).toBe(2);
                // Installation alone is not completed recovery: both ACKs must
                // succeed before another immediate rebuild can be earned.
                yield* TestClock.adjust(0);
                expect(attempts).toBe(2);
                expect(yield* Clock.currentTimeMillis).toBe(start);
                yield* TestClock.adjust(999);
                expect(attempts).toBe(2);
                yield* TestClock.adjust(1);
                expect(yield* Queue.take(opened)).toBe(3);
                expect(yield* Queue.take(acknowledged)).toBe(3);
                expect(yield* child.confirmed.get("Counter", "one")).toEqual({ id: "one", count: 1 });
            })
        )
    );

const authenticationParent = Effect.fnUntraced(function* () {
    const authority = yield* makeOwnedBackend({
        namespace: "authentication-parent-authority",
        ir,
        tables: yield* Memory.make(),
        mutators: { seed: () => Effect.void },
    });
    const parent = yield* makeReplica({
        namespace: "authentication-parent",
        ir,
        tables: yield* Memory.make(),
        backend: authority,
        startSync: false,
        live: false,
        objectCacheGc: false,
        execute: () => Effect.void,
    });
    return replicaStateSource(parent);
});

for (const failureAt of ["acquire", "stream"] as const)
    for (const activationRaces of [false, true])
        it.effect(
            `${failureAt} authentication failure resumes on ${activationRaces ? "racing" : "later"} activation without polling`,
            () =>
                Effect.scoped(
                    Effect.gen(function* () {
                        const actual = yield* authenticationParent();
                        const opened = yield* Queue.unbounded<{ attempt: number; at: number }>();
                        const waiting = yield* Queue.unbounded<number>();
                        const activation = yield* PubSub.unbounded<void>();
                        let generation = 0;
                        let active = false;
                        let attempts = 0;
                        let subscriptions = 0;
                        const failure = new BackendError({
                            operation: "test.delivery.auth",
                            kind: "Unauthenticated",
                            retryable: false,
                            message: "Sign in again.",
                        });
                        const activate = Effect.gen(function* () {
                            active = true;
                            generation++;
                            yield* PubSub.publish(activation, undefined);
                        });
                        const authentication = {
                            generation: Effect.sync(() => generation),
                            awaitActivation: (after: number) =>
                                Effect.scoped(
                                    Effect.gen(function* () {
                                        const changes = yield* PubSub.subscribe(activation);
                                        yield* Queue.offer(waiting, after);
                                        yield* Stream.concat(
                                            Stream.succeed(undefined),
                                            Stream.fromSubscription(changes)
                                        ).pipe(
                                            Stream.filter(() => active && generation > after),
                                            Stream.runHead
                                        );
                                    })
                                ),
                        };
                        const source: OntologySource = {
                            ...actual,
                            subscribe: () =>
                                Effect.gen(function* () {
                                    const attempt = ++attempts;
                                    yield* Effect.acquireRelease(
                                        Effect.sync(() => subscriptions++),
                                        () => Effect.sync(() => subscriptions--)
                                    );
                                    yield* Queue.offer(opened, {
                                        attempt,
                                        at: yield* Clock.currentTimeMillis,
                                    });
                                    if (attempt === 1 && failureAt === "acquire") return yield* failure;
                                    return {
                                        frames:
                                            attempt === 1 && failureAt === "stream"
                                                ? Stream.fail(failure)
                                                : Stream.never,
                                        acknowledge: () => Effect.void,
                                    };
                                }),
                        };
                        const child = yield* makeReplica({
                            namespace: "authentication-child",
                            ir,
                            tables: yield* Memory.make(),
                            source,
                            startSync: false,
                            objectCacheGc: false,
                            execute: () => Effect.void,
                        });
                        const controller = {
                            ...child,
                            reportReplicationFailure: (error?: BackendError) =>
                                child
                                    .reportReplicationFailure(error)
                                    .pipe(Effect.andThen(error && activationRaces ? activate : Effect.void)),
                        };
                        const start = yield* Clock.currentTimeMillis;
                        const connection = yield* connectReplicaDelivery(controller, source, {
                            authentication,
                        });
                        expect(yield* Queue.take(opened)).toEqual({ attempt: 1, at: start });
                        expect(yield* Queue.take(waiting)).toBe(0);
                        expect(yield* connection.lastError).toBe(failure);
                        if (!activationRaces) {
                            expect(subscriptions).toBe(0);
                            yield* TestClock.adjust(60_000);
                            expect(attempts).toBe(1);
                            yield* activate;
                        }
                        expect(yield* Queue.take(opened)).toEqual({
                            attempt: 2,
                            at: start + (activationRaces ? 0 : 60_000),
                        });
                        expect(attempts).toBe(2);
                        expect(subscriptions).toBe(1);
                    })
                )
        );

for (const kind of ["SchemaMismatch", "SourceMismatch"] as const)
    it.effect(`${kind} delivery failures remain terminal with authentication available`, () =>
        Effect.scoped(
            Effect.gen(function* () {
                const actual = yield* authenticationParent();
                const failed = yield* Deferred.make<void>();
                let attempts = 0;
                let waits = 0;
                const source: OntologySource = {
                    ...actual,
                    subscribe: () =>
                        Effect.suspend(() => {
                            attempts++;
                            return Effect.fail(
                                new BackendError({
                                    operation: "test.delivery.terminal",
                                    kind,
                                    retryable: false,
                                    message: "Different source or schema.",
                                })
                            );
                        }),
                };
                const child = yield* makeReplica({
                    namespace: "authentication-terminal-child",
                    ir,
                    tables: yield* Memory.make(),
                    source,
                    startSync: false,
                    objectCacheGc: false,
                    execute: () => Effect.void,
                });
                const controller = {
                    ...child,
                    reportReplicationFailure: (error?: BackendError) =>
                        child
                            .reportReplicationFailure(error)
                            .pipe(Effect.andThen(error ? Deferred.succeed(failed, undefined) : Effect.void)),
                };
                yield* connectReplicaDelivery(controller, source, {
                    authentication: {
                        generation: Effect.succeed(0),
                        awaitActivation: () =>
                            Effect.sync(() => {
                                waits++;
                            }),
                    },
                });
                yield* Deferred.await(failed);
                yield* TestClock.adjust(60_000);
                expect(attempts).toBe(1);
                expect(waits).toBe(0);
            })
        )
    );
