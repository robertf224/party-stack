import { Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { expect, test } from "vite-plus/test";
import { scopedByteSource } from "./bytes.js";

test("caller scopes release an acquired source before consumption without closing its owner", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owner = yield* Effect.scope;
                let active = 0;
                const acquire = Effect.acquireRelease(
                    Effect.sync(() => {
                        active++;
                        return { type: "text/plain", stream: Stream.never };
                    }),
                    () =>
                        Effect.sync(() => {
                            active--;
                        })
                );
                const first = yield* Scope.fork(owner);
                const source = yield* Scope.provide(scopedByteSource(acquire, owner), first);
                const second = yield* Scope.fork(owner);
                yield* Scope.provide(scopedByteSource(acquire, owner), second);
                expect(active).toBe(2);
                yield* Scope.close(first, Exit.void);
                expect(active).toBe(1);
                expect(Exit.hasInterrupts(yield* Effect.exit(Stream.runDrain(source.stream)))).toBe(true);
                yield* Scope.close(second, Exit.void);
                expect(active).toBe(0);
                expect(owner.state._tag).not.toBe("Closed");
            })
        )
    );
});

test("closing the caller interrupts pending acquisition and active consumption", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owner = yield* Effect.scope;
                const caller = yield* Scope.fork(owner);
                const started = yield* Deferred.make<void>();
                let released = false;
                const pending = yield* Effect.forkScoped(
                    Scope.provide(
                        scopedByteSource(
                            Effect.acquireRelease(Deferred.succeed(started, undefined), () =>
                                Effect.sync(() => {
                                    released = true;
                                })
                            ).pipe(Effect.andThen(Effect.never)),
                            owner
                        ),
                        caller
                    )
                );
                yield* Deferred.await(started);
                yield* Scope.close(caller, Exit.void);
                expect(Exit.hasInterrupts(yield* Fiber.await(pending))).toBe(true);
                expect(released).toBe(true);

                const consumingScope = yield* Scope.fork(owner);
                const received = yield* Deferred.make<void>();
                const source = yield* Scope.provide(
                    scopedByteSource(
                        Effect.succeed({
                            type: "application/octet-stream",
                            stream: Stream.concat(Stream.make(new Uint8Array([1])), Stream.never),
                        }),
                        owner
                    ),
                    consumingScope
                );
                const consuming = yield* Effect.forkScoped(
                    Stream.runForEach(source.stream, () => Deferred.succeed(received, undefined))
                );
                yield* Deferred.await(received);
                yield* Scope.close(consumingScope, Exit.void);
                // Unknown-size bodies must fail on cancellation, rather than succeed as a truncated file.
                expect(Exit.hasInterrupts(yield* Fiber.await(consuming))).toBe(true);
            })
        )
    );
});
