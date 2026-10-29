import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime, getRuntime } from "@party-stack/runtime";
import { Deferred, Effect, Fiber } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { layer } from "./createNodeRuntime.js";
import type { RuntimeAdapter } from "@party-stack/runtime";

const native = vi.hoisted(() => ({ opened: vi.fn(), closed: vi.fn() }));
vi.mock("better-sqlite3", () => ({
    default: class {
        constructor() {
            native.opened();
        }
        close() {
            native.closed();
        }
        exec() {}
        prepare() {
            return { all: () => [], run: () => undefined };
        }
    },
}));

test("Node layers acquire lazily and interruption closes SQLite without a runtime cleanup call", async () => {
    const directory = await mkdtemp(join(tmpdir(), "party-stack-scoped-"));
    try {
        const runtimeLayer = layer({ owner: "user", namespace: "node", dataDirectory: directory });
        expect(native.opened).not.toHaveBeenCalled();
        let adapter: RuntimeAdapter | undefined;
        await Effect.runPromise(
            Effect.gen(function* () {
                const ready = yield* Deferred.make<void>();
                const fiber = yield* Effect.forkChild(
                    Effect.gen(function* () {
                        adapter = (yield* Runtime).adapter;
                        yield* Deferred.succeed(ready, undefined);
                        yield* Effect.never;
                    }).pipe(Effect.provide(runtimeLayer))
                );
                yield* Deferred.await(ready);
                yield* Fiber.interrupt(fiber);
            })
        );
        expect(native.opened).toHaveBeenCalledOnce();
        expect(native.closed).toHaveBeenCalledOnce();
        expect(() => getRuntime(adapter!)).toThrow(/closed/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
