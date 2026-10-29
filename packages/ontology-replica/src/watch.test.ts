import { BackendError } from "@party-stack/ontology-backend";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { superviseWatch } from "./watch.js";

test("watch retries honor retry-after and close the previous scope before reopening", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const failed = yield* Deferred.make<void>();
                const reopened = yield* Deferred.make<void>();
                let attempts = 0,
                    released = 0;
                const fiber = yield* Effect.forkChild(
                    superviseWatch({
                        stream: () =>
                            Stream.unwrap(
                                Effect.gen(function* () {
                                    yield* Effect.acquireRelease(
                                        Effect.sync(() => ++attempts),
                                        () =>
                                            Effect.sync(() => {
                                                released++;
                                            })
                                    );
                                    if (attempts === 1)
                                        return Stream.fail(
                                            new BackendError({
                                                operation: "watch",
                                                kind: "RateLimited",
                                                message: "Wait",
                                                retryable: true,
                                                retryAfterMs: 2_500,
                                            })
                                        );
                                    expect(released).toBe(1);
                                    yield* Deferred.succeed(reopened, undefined);
                                    return Stream.never;
                                })
                            ),
                        onValue: () => Effect.void,
                        onError: (error) =>
                            error ? Deferred.succeed(failed, undefined).pipe(Effect.asVoid) : Effect.void,
                    })
                );
                yield* Deferred.await(failed);
                expect(released).toBe(1);
                yield* TestClock.adjust(2_000);
                expect(attempts).toBe(1);
                yield* TestClock.adjust(500);
                yield* Deferred.await(reopened);
                yield* Fiber.interrupt(fiber);
                expect(released).toBe(2);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});

test("a terminal watch failure is reported once and never silently retried", async () => {
    let attempts = 0;
    const errors: string[] = [];
    await Effect.runPromise(
        superviseWatch({
            stream: () => {
                attempts++;
                return Stream.fail(
                    new BackendError({
                        operation: "watch",
                        kind: "Forbidden",
                        message: "Denied",
                        retryable: false,
                    })
                );
            },
            onValue: () => Effect.void,
            onError: (error) =>
                Effect.sync(() => {
                    if (error) errors.push(error.kind);
                }),
        })
    );
    expect(attempts).toBe(1);
    expect(errors).toEqual(["Forbidden"]);
});

test("normal watch EOF reconnects rather than leaving a dead subscription", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let attempts = 0;
                const ended = yield* Deferred.make<void>();
                const reopened = yield* Deferred.make<void>();
                yield* Effect.forkChild(
                    superviseWatch({
                        stream: () =>
                            ++attempts === 1
                                ? Stream.empty
                                : Stream.fromEffect(Deferred.succeed(reopened, undefined)).pipe(
                                      Stream.concat(Stream.never)
                                  ),
                        onValue: () => Effect.void,
                        onError: (error) =>
                            error ? Deferred.succeed(ended, undefined).pipe(Effect.asVoid) : Effect.void,
                    })
                );
                yield* Deferred.await(ended);
                yield* TestClock.adjust(1_000);
                yield* Deferred.await(reopened);
                expect(attempts).toBe(2);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});
