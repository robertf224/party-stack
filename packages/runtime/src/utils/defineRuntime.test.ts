import { Effect, Exit, Scope } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { MemoryBlobBytesStore } from "../memory/MemoryBlobBytesStore.js";
import { Runtime, getRuntime } from "../Runtime.js";
import { defineRuntime } from "./defineRuntime.js";

test("custom providers are lazy Effects and their caller scope owns acquisition and cleanup", async () => {
    const opened = vi.fn();
    const closed = vi.fn();
    const provider = defineRuntime((owner, namespace) =>
        Effect.gen(function* () {
            yield* Effect.acquireRelease(Effect.sync(opened), () => Effect.sync(closed));
            return { owner, namespace, blobBytes: new MemoryBlobBytesStore() };
        })
    );
    const acquisition = provider("test", "scope");
    expect(opened).not.toHaveBeenCalled();
    const scope = Effect.runSync(Scope.make());
    const runtime = await Effect.runPromise(Scope.provide(acquisition, scope));
    expect(opened).toHaveBeenCalledOnce();
    expect(getRuntime(runtime.adapter)).toBe(runtime);
    const same = await Effect.runPromise(Scope.provide(Runtime.make(runtime.adapter), scope));
    expect(same).toBe(runtime);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(closed).toHaveBeenCalledOnce();
    expect(() => getRuntime(runtime.adapter)).toThrow(/closed/);
});
