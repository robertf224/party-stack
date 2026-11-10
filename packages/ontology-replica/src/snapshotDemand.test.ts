import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Effect, Exit, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { replicaStateSource } from "./infrastructure.js";
import { makeReplica } from "./service.js";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [{ name: "id", displayName: "ID", type: o.string({}) }],
        },
    ],
};
const subset = { from: { source: { objectType: "Item" }, binding: "item" } };
const setup = Effect.fnUntraced(function* () {
    const owned = yield* makeOwnedBackend({
        namespace: "authority",
        ir,
        tables: yield* Memory.make(),
        mutators: {},
    });
    yield* owned.storage.transaction((tx) => tx.put("Item", { id: "one" }));
    const parent = yield* makeReplica({
        namespace: "parent",
        ir,
        tables: yield* Memory.make(),
        backend: owned,
        live: false,
    });
    yield* parent.demand.acquire(subset);
    return replicaStateSource(parent);
});

test("device offline status does not block a snapshot lease to a reachable local parent", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const parent = yield* setup();
                const child = yield* makeReplica({
                    namespace: "offline-child",
                    ir,
                    tables: yield* Memory.make(),
                    live: false,
                    network: { online: Effect.succeed(false), changes: Stream.never },
                    source: { ...parent, subscribe: undefined },
                });
                yield* child.demand.acquire(subset).pipe(Effect.timeout(500));
                expect(yield* child.get("Item", "one")).toEqual({ id: "one" });
                expect((yield* child.status.get).networkOnline).toBe(false);
            })
        )
    );
});

test.each(["RateLimited", "Forbidden"] as const)(
    "snapshot demand reports %s after readiness and owns retry/cleanup",
    async (kind) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const parent = yield* setup();
                    const disconnect = yield* Deferred.make<void>();
                    let attempts = 0,
                        active = 0;
                    const failure = new BackendError({
                        operation: "Demand",
                        kind,
                        retryable: kind === "RateLimited",
                        retryAfterMs: 2_500,
                        message: "Lease stopped.",
                    });
                    const child = yield* makeReplica({
                        namespace: "child",
                        ir,
                        tables: yield* Memory.make(),
                        live: false,
                        source: {
                            ...parent,
                            subscribe: undefined,
                            demand: (request) =>
                                Stream.unwrap(
                                    Effect.acquireRelease(
                                        Effect.sync(() => {
                                            active++;
                                            return ++attempts;
                                        }),
                                        () =>
                                            Effect.sync(() => {
                                                active--;
                                            })
                                    ).pipe(
                                        Effect.map((attempt) =>
                                            parent
                                                .demand(request)
                                                .pipe(
                                                    Stream.mergeEffect(
                                                        attempt === 1
                                                            ? Deferred.await(disconnect).pipe(
                                                                  Effect.andThen(Effect.fail(failure))
                                                              )
                                                            : Effect.never
                                                    )
                                                )
                                        )
                                    )
                                ),
                        },
                    });
                    const consumer = yield* Scope.make();
                    yield* Effect.addFinalizer(() => Scope.close(consumer, Exit.void));
                    yield* Scope.provide(child.demand.acquire(subset), consumer);
                    expect(yield* child.get("Item", "one")).toEqual({ id: "one" });
                    expect(attempts).toBe(1);
                    yield* Deferred.succeed(disconnect, undefined);
                    yield* TestClock.adjust(0);
                    expect((yield* child.status.get).demands[0]?.watchError).toMatchObject({ kind });
                    expect(active).toBe(0);
                    yield* TestClock.adjust(2_499);
                    expect(attempts).toBe(1);
                    yield* TestClock.adjust(1);
                    expect(attempts).toBe(kind === "RateLimited" ? 2 : 1);
                    const status = yield* child.status.get;
                    expect(status.demands[0]?.watchError?.kind).toBe(
                        kind === "RateLimited" ? undefined : "Forbidden"
                    );
                    yield* Scope.close(consumer, Exit.void);
                    expect(active).toBe(0);
                    const stopped = attempts;
                    yield* TestClock.adjust(60_000);
                    expect(attempts).toBe(stopped);
                })
            ).pipe(Effect.provide(TestClock.layer()))
        );
    }
);

test.each(["failure", "defect"] as const)(
    "an initial snapshot demand %s releases its attempt instead of leaving retries behind",
    async (mode) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const parent = yield* setup();
                    let attempts = 0,
                        active = 0;
                    const child = yield* makeReplica({
                        namespace: "child",
                        ir,
                        tables: yield* Memory.make(),
                        live: false,
                        source: {
                            ...parent,
                            subscribe: undefined,
                            demand: () =>
                                Stream.unwrap(
                                    Effect.acquireRelease(
                                        Effect.sync(() => {
                                            attempts++;
                                            active++;
                                        }),
                                        () =>
                                            Effect.sync(() => {
                                                active--;
                                            })
                                    ).pipe(
                                        Effect.as(
                                            mode === "defect"
                                                ? Stream.die("private startup detail")
                                                : Stream.fail(
                                                      new BackendError({
                                                          operation: "Demand",
                                                          kind: "Unavailable",
                                                          retryable: true,
                                                          message: "Not connected.",
                                                      })
                                                  )
                                        )
                                    )
                                ),
                        },
                    });
                    const result = yield* Effect.result(Effect.scoped(child.demand.acquire(subset)));
                    expect(result).toMatchObject({
                        _tag: "Failure",
                        failure: { kind: mode === "defect" ? "Internal" : "Unavailable" },
                    });
                    if (result._tag === "Failure")
                        expect(result.failure.message).not.toContain("private startup detail");
                    expect(active).toBe(0);
                    yield* TestClock.adjust(60_000);
                    expect(attempts).toBe(1);
                })
            ).pipe(Effect.provide(TestClock.layer()))
        );
    }
);

test.each(["RateLimited", "Forbidden"] as const)(
    "snapshot change hints expose %s without blocking finite reads",
    async (kind) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const parent = yield* setup();
                    const disconnect = yield* Deferred.make<void>();
                    let attempts = 0,
                        active = 0;
                    const owner = yield* Scope.make();
                    yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
                    const child = yield* Scope.provide(
                        makeReplica({
                            namespace: "child",
                            ir,
                            tables: yield* Memory.make(),
                            source: {
                                ...parent,
                                subscribe: undefined,
                                subscribeChanges: Effect.gen(function* () {
                                    const attempt = yield* Effect.acquireRelease(
                                        Effect.sync(() => {
                                            active++;
                                            return ++attempts;
                                        }),
                                        () =>
                                            Effect.sync(() => {
                                                active--;
                                            })
                                    );
                                    const changes = yield* parent.subscribeChanges;
                                    return changes.pipe(
                                        Stream.mergeEffect(
                                            attempt === 1
                                                ? Deferred.await(disconnect).pipe(
                                                      Effect.andThen(
                                                          Effect.fail(
                                                              new BackendError({
                                                                  operation: "Changes",
                                                                  kind,
                                                                  retryable: kind === "RateLimited",
                                                                  retryAfterMs: 2_500,
                                                                  message: "Watch stopped.",
                                                              })
                                                          )
                                                      )
                                                  )
                                                : Effect.never
                                        )
                                    );
                                }),
                            },
                        }),
                        owner
                    );
                    yield* Scope.provide(child.demand.acquire(subset), owner);
                    yield* Deferred.succeed(disconnect, undefined);
                    yield* TestClock.adjust(0);
                    expect((yield* child.status.get).watchError).toMatchObject({ kind });
                    expect((yield* child.status.get).replicationError).toBeUndefined();
                    expect(active).toBe(0);
                    // A watch failure does not prohibit independent request/response reads.
                    yield* child.syncOnce;
                    expect(yield* child.get("Item", "one")).toEqual({ id: "one" });
                    yield* TestClock.adjust(2_499);
                    expect(attempts).toBe(1);
                    yield* TestClock.adjust(1);
                    expect(attempts).toBe(kind === "RateLimited" ? 2 : 1);
                    expect((yield* child.status.get).watchError?.kind).toBe(
                        kind === "RateLimited" ? undefined : "Forbidden"
                    );
                    yield* Scope.close(owner, Exit.void);
                    expect(active).toBe(0);
                })
            ).pipe(Effect.provide(TestClock.layer()))
        );
    }
);
