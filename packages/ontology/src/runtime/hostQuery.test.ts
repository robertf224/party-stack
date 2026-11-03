import { objectSubset } from "@party-stack/ontology-backend/subset";
import { Deferred, Effect, Fiber, PubSub, Stream } from "effect";
import { expect, test } from "vite-plus/test";
import { observeReplicaRows } from "./hostQuery.js";
import type { CompiledSubset } from "@party-stack/ontology-backend/subset";
import type { ObjectSubset } from "@party-stack/ontology-spec/query";

test("query streams do not miss a commit racing the initial snapshot and release demand", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const events = yield* PubSub.sliding<void>(1);
                let revision = 0;
                let leases = 0;
                const subset: CompiledSubset = { objectType: "Note", query: { limit: 1 } };
                const requested: ObjectSubset[] = [];
                const stream = observeReplicaRows(
                    {
                        demand: {
                            acquire: (value) =>
                                Effect.acquireRelease(
                                    Effect.sync(() => {
                                        requested.push(value);
                                        leases++;
                                    }),
                                    () =>
                                        Effect.sync(() => {
                                            leases--;
                                        })
                                ),
                        },
                        observeSubset: (query) =>
                            Stream.unwrap(
                                Effect.gen(function* () {
                                    const changes = yield* PubSub.subscribe(events);
                                    expect(query).toEqual(objectSubset("Note", { limit: 1 }));
                                    const value = revision;
                                    if (revision === 0) {
                                        revision++;
                                        yield* PubSub.publish(events, undefined);
                                    }
                                    return Stream.concat(
                                        Stream.succeed({
                                            reset: true,
                                            removed: [],
                                            rows: [{ key: "one", value: { id: "one", revision: value } }],
                                        }),
                                        Stream.fromSubscription(changes).pipe(
                                            Stream.map(() => ({
                                                reset: false,
                                                removed: [],
                                                rows: [{ key: "one", value: { id: "one", revision } }],
                                            }))
                                        )
                                    );
                                })
                            ),
                    },
                    subset
                );
                const snapshots = yield* Stream.runCollect(Stream.take(stream, 2));
                expect(snapshots.map((rows) => rows[0]?.value.revision)).toEqual([0, 1]);
                expect(requested).toEqual([objectSubset(subset.objectType, subset.query)]);
                expect(leases).toBe(0);
                yield* PubSub.shutdown(events);
            })
        )
    );
});

test("inspection streams hold only a local reader lease and cancellation releases it", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const events = yield* PubSub.sliding<void>(1);
                const received = yield* Deferred.make<void>();
                let readers = 0;
                let remote = 0;
                const fiber = yield* Stream.runForEach(
                    observeReplicaRows(
                        {
                            demand: {
                                acquire: (_subset, settings) => {
                                    if (!settings?.localOnly)
                                        return Effect.sync(() => {
                                            remote++;
                                        });
                                    return Effect.acquireRelease(
                                        Effect.sync(() => {
                                            readers++;
                                        }),
                                        () =>
                                            Effect.sync(() => {
                                                readers--;
                                            })
                                    );
                                },
                            },
                            observeSubset: () =>
                                Stream.concat(
                                    Stream.succeed({
                                        reset: true,
                                        removed: [],
                                        rows: [{ key: "one", value: { id: "one" } }],
                                    }),
                                    Stream.never
                                ),
                        },
                        { objectType: "Note" },
                        { persistedOnly: true }
                    ),
                    () => Deferred.succeed(received, undefined)
                ).pipe(Effect.forkScoped({ startImmediately: true }));
                yield* Deferred.await(received);
                expect(readers).toBe(1);
                expect(remote).toBe(0);
                yield* Fiber.interrupt(fiber);
                expect(readers).toBe(0);
                yield* PubSub.shutdown(events);
            })
        )
    );
});
