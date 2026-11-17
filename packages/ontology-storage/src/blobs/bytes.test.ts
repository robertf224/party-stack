import { Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, test, vi } from "vite-plus/test";
import { configureNativeSha256, digestBytes, scopedByteSource } from "./bytes.js";

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

describe("native SHA-256", () => {
    const portable = (bytes: Uint8Array<ArrayBuffer>) => Effect.runPromise(digestBytes(new Blob([bytes])));
    afterEach(() => configureNativeSha256(undefined));

    it("hashes bounded inputs with the platform digest and matches portable output", async () => {
        const bytes = new Uint8Array(200_000).map((_, index) => index % 251);
        const expected = await portable(bytes);
        const native = vi.fn((input: Uint8Array<ArrayBuffer>) => crypto.subtle.digest("SHA-256", input));
        configureNativeSha256(native);
        expect(await portable(bytes)).toBe(expected);
        expect(native).toHaveBeenCalledTimes(1);
        expect(native.mock.calls[0]![0]).toEqual(bytes);
        // Unknown-size one-shot streams are buffered only up to the bound.
        expect(
            await Effect.runPromise(
                digestBytes({ type: "application/octet-stream", stream: Stream.make(bytes) })
            )
        ).toBe(expected);
    });

    it("keeps streaming portable hashing above the bound", async () => {
        const bytes = new Uint8Array(9 * 1024 * 1024).fill(3);
        const expected = await portable(bytes);
        const native = vi.fn((input: Uint8Array<ArrayBuffer>) => crypto.subtle.digest("SHA-256", input));
        configureNativeSha256(native);
        expect(await portable(bytes)).toBe(expected);
        expect(
            await Effect.runPromise(
                digestBytes({ type: "application/octet-stream", stream: Stream.make(bytes) })
            )
        ).toBe(expected);
        expect(native).not.toHaveBeenCalled();
    });

    it("reports platform digest failures", async () => {
        configureNativeSha256(() => Promise.reject(new Error("native failed")));
        await expect(portable(new Uint8Array([1]))).rejects.toThrow();
    });
});
