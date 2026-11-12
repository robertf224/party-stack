import { BackendError } from "@party-stack/ontology-backend";
import { Deferred, Effect, Fiber, Random, Stream } from "effect";
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
                        acquire: () =>
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
                            }),
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
            authentication: {
                generation: Effect.succeed(0),
                awaitActivation: () => Effect.die("Forbidden must not wait for authentication."),
            },
            acquire: () => {
                attempts++;
                return Effect.succeed(
                    Stream.fail(
                        new BackendError({
                            operation: "watch",
                            kind: "Forbidden",
                            message: "Denied",
                            retryable: false,
                        })
                    )
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

test("an unauthenticated watch waits for a new credential activation before reopening", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const waiting = yield* Deferred.make<void>();
                const activation = yield* Deferred.make<void>();
                const reopened = yield* Deferred.make<void>();
                let generation = 0,
                    attempts = 0,
                    released = 0;
                yield* superviseWatch({
                    authentication: {
                        generation: Effect.sync(() => generation),
                        awaitActivation: (after) =>
                            Effect.gen(function* () {
                                expect(after).toBe(0);
                                expect(released).toBe(1);
                                yield* Deferred.succeed(waiting, undefined);
                                yield* Deferred.await(activation);
                                expect(generation).toBeGreaterThan(after);
                            }),
                    },
                    acquire: () =>
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
                                        kind: "Unauthenticated",
                                        retryable: false,
                                        message: "Sign in again.",
                                    })
                                );
                            yield* Deferred.succeed(reopened, undefined);
                            return Stream.never;
                        }),
                    onValue: () => Effect.void,
                    onError: () => Effect.void,
                }).pipe(Effect.forkScoped);
                yield* Deferred.await(waiting);
                yield* TestClock.adjust(60_000);
                expect(attempts).toBe(1);
                generation++;
                yield* Deferred.succeed(activation, undefined);
                yield* Deferred.await(reopened);
                expect(attempts).toBe(2);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
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
                        acquire: () =>
                            Effect.succeed(
                                ++attempts === 1
                                    ? Stream.empty
                                    : Stream.fromEffect(Deferred.succeed(reopened, undefined)).pipe(
                                          Stream.concat(Stream.never)
                                      )
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

// The upper end of equal jitter waits for the full backoff delay.
const maximumJitter = Effect.provideService(Random.Random, {
    nextIntUnsafe: () => Number.MAX_SAFE_INTEGER,
    nextDoubleUnsafe: () => 0.999_999,
});
const unavailable = new BackendError({
    operation: "watch",
    kind: "Unavailable",
    message: "Closed",
    retryable: true,
});

test("watch attempts report whether they opened and delivered, and a stable acquisition resets backoff", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const reports: { error?: string; established?: boolean; delivered?: boolean }[] = [];
                const opened: number[] = [];
                let attempts = 0;
                const fiber = yield* Effect.forkChild(
                    superviseWatch({
                        retryDelayMs: 1_000,
                        stableMs: 5_000,
                        acquire: () =>
                            Effect.gen(function* () {
                                const attempt = ++attempts;
                                opened.push(attempt);
                                if (attempt === 1) return yield* Effect.fail(unavailable);
                                if (attempt === 2)
                                    return Stream.make(1).pipe(Stream.concat(Stream.fail(unavailable)));
                                if (attempt === 3)
                                    return Stream.fromEffect(Effect.sleep(6_000)).pipe(
                                        Stream.drain,
                                        Stream.concat(Stream.fail(unavailable))
                                    );
                                return Stream.never;
                            }),
                        onValue: () => Effect.void,
                        onError: (error, attempt) =>
                            Effect.sync(() => {
                                if (error)
                                    reports.push({
                                        error: error.kind,
                                        established: attempt?.established,
                                        delivered: attempt?.delivered,
                                    });
                            }),
                    }).pipe(maximumJitter)
                );
                yield* Effect.yieldNow;
                expect(reports).toEqual([{ error: "Unavailable", established: false, delivered: false }]);
                yield* TestClock.adjust(1_000);
                yield* Effect.yieldNow;
                expect(reports[1]).toEqual({ error: "Unavailable", established: true, delivered: true });
                // A delivered value reset the backoff to its initial delay.
                yield* TestClock.adjust(1_000);
                yield* Effect.yieldNow;
                expect(opened).toEqual([1, 2, 3]);
                // The third acquisition stayed open longer than stableMs, so its
                // undelivered failure still retries after the initial delay.
                yield* TestClock.adjust(6_000);
                yield* Effect.yieldNow;
                expect(reports[2]).toEqual({ error: "Unavailable", established: true, delivered: false });
                yield* TestClock.adjust(1_000);
                yield* Effect.yieldNow;
                expect(opened).toEqual([1, 2, 3, 4]);
                yield* Fiber.interrupt(fiber);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});

test("watch backoff doubles with jitter up to five minutes", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let attempts = 0;
                const fiber = yield* Effect.forkChild(
                    superviseWatch({
                        retryDelayMs: 60_000,
                        acquire: () =>
                            Effect.sync(() => {
                                attempts++;
                                return Stream.fail(unavailable);
                            }),
                        onValue: () => Effect.void,
                        onError: () => Effect.void,
                    }).pipe(maximumJitter)
                );
                yield* Effect.yieldNow;
                // 60 s, 120 s, 240 s, then capped at 300 s.
                for (const [wait, expected] of [
                    [60_000, 2],
                    [120_000, 3],
                    [240_000, 4],
                    [300_000, 5],
                    [300_000, 6],
                ] as const) {
                    yield* TestClock.adjust(wait - 1);
                    yield* Effect.yieldNow;
                    expect(attempts).toBe(expected - 1);
                    yield* TestClock.adjust(1);
                    yield* Effect.yieldNow;
                    expect(attempts).toBe(expected);
                }
                yield* Fiber.interrupt(fiber);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});

test("a non-retryable watch failure runs the terminal fallback instead of retrying", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            let attempts = 0;
            const terminal: string[] = [];
            yield* superviseWatch({
                acquire: () =>
                    Effect.sync(() => {
                        attempts++;
                        return Stream.fail(
                            new BackendError({
                                operation: "watch",
                                kind: "InvalidRequest",
                                message: "Rejected",
                                retryable: false,
                            })
                        );
                    }),
                onValue: () => Effect.void,
                onError: () => Effect.void,
                onTerminal: (error) => Effect.sync(() => terminal.push(error.kind)),
            });
            expect(attempts).toBe(1);
            expect(terminal).toEqual(["InvalidRequest"]);
        })
    );
});
