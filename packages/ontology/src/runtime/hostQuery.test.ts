import { Deferred, Effect, Fiber, PubSub, Stream } from "effect";
import { expect, test } from "vite-plus/test";
import { observeReplicaRows } from "./hostQuery.js";
import type { BackendSubset } from "@party-stack/ontology-backend";

test("query streams do not miss a commit racing the initial snapshot and release demand", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const events = yield* PubSub.sliding<void>(1);
                let revision = 0;
                let leases = 0;
                const subset: BackendSubset = { objectType: "Note", query: { limit: 1 } };
                const requested: BackendSubset[] = [];
                const stream = observeReplicaRows(
                    {
                        subscribeChanges: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
                        demand: (value) =>
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
                        retainLocal: () => Effect.die("Remote query used inspection lease"),
                        loadSubset: (type, query) =>
                            Effect.gen(function* () {
                                expect(type).toBe("Note");
                                expect(query).toEqual({ limit: 1 });
                                const value = revision;
                                if (revision === 0) {
                                    revision++;
                                    yield* PubSub.publish(events, undefined);
                                }
                                return [{ key: "one", value: { id: "one", revision: value } }];
                            }),
                    },
                    subset
                );
                const snapshots = yield* Stream.runCollect(Stream.take(stream, 2));
                expect(snapshots.map((rows) => rows[0]?.value.revision)).toEqual([0, 1]);
                expect(requested).toEqual([subset]);
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
                            subscribeChanges: PubSub.subscribe(events).pipe(
                                Effect.map(Stream.fromSubscription)
                            ),
                            demand: () =>
                                Effect.sync(() => {
                                    remote++;
                                }),
                            retainLocal: () =>
                                Effect.acquireRelease(
                                    Effect.sync(() => {
                                        readers++;
                                    }),
                                    () =>
                                        Effect.sync(() => {
                                            readers--;
                                        })
                                ),
                            loadSubset: () => Effect.succeed([{ key: "one", value: { id: "one" } }]),
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
