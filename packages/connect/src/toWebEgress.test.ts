import { Effect, Scope, Exit, Deferred } from "effect";
import { expect, test } from "vite-plus/test";
import { toWebEgress } from "./toWebEgress.js";

test("the SDK Promise bridge cancels with its owner and rejects calls after release", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const scope = yield* Scope.fork(yield* Effect.scope);
                const started = yield* Deferred.make<void>();
                let cancelled = 0;
                let calls = 0;
                const web = yield* toWebEgress({
                    fetch: () =>
                        Effect.gen(function* () {
                            calls++;
                            yield* Deferred.succeed(started, undefined);
                            return yield* Effect.never;
                        }).pipe(
                            Effect.ensuring(
                                Effect.sync(() => {
                                    cancelled++;
                                })
                            )
                        ),
                    createWebSocket: () => Effect.die("unused"),
                }).pipe(Scope.provide(scope));
                const request = web.fetch("https://service.test");
                void request.catch(() => undefined);
                yield* Deferred.await(started);
                yield* Scope.close(scope, Exit.void);
                yield* Effect.promise(() => expect(request).rejects.toBeDefined());
                yield* Effect.promise(() =>
                    expect(web.fetch("https://service.test")).rejects.toMatchObject({ kind: "Unavailable" })
                );
                expect(calls).toBe(1);
                expect(cancelled).toBe(1);
            })
        )
    );
});

test("the SDK request's AbortSignal interrupts native egress", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const started = yield* Deferred.make<void>();
                let cancelled = false;
                const web = yield* toWebEgress({
                    fetch: () =>
                        Deferred.succeed(started, undefined).pipe(
                            Effect.andThen(Effect.never),
                            Effect.ensuring(
                                Effect.sync(() => {
                                    cancelled = true;
                                })
                            )
                        ),
                    createWebSocket: () => Effect.die("unused"),
                });
                const controller = new AbortController();
                const request = web.fetch("https://service.test", { signal: controller.signal });
                void request.catch(() => undefined);
                yield* Deferred.await(started);
                controller.abort();
                yield* Effect.promise(() => expect(request).rejects.toBeDefined());
                expect(cancelled).toBe(true);
            })
        )
    );
});
