import { describe, expect, it, vi } from "vitest";
import { defineRuntime } from "./defineRuntime.js";

describe("defineRuntime", () => {
    it("deduplicates lifecycle calls and cleans up before destroying", async () => {
        let resolveCleanup:
            | (() => void)
            | undefined;
        const cleanupResult = new Promise<void>(
            (resolve) => {
                resolveCleanup = resolve;
            }
        );
        const cleanup = vi.fn(
            () => cleanupResult
        );
        const destroy = vi.fn(() =>
            Promise.resolve()
        );
        const provider = defineRuntime(
            (owner, namespace) => ({
                owner,
                namespace,
                blobBytes: {} as never,
                coordination: {} as never,
                cleanup,
                destroy,
            })
        );
        const runtime = provider(
            "test",
            "runtime"
        );
        if (!runtime.cleanup || !runtime.destroy) {
            throw new Error(
                "Expected managed lifecycle methods."
            );
        }

        const firstCleanup = runtime.cleanup();
        const secondCleanup = runtime.cleanup();
        const firstDestroy = runtime.destroy();
        const secondDestroy = runtime.destroy();
        await Promise.resolve();

        expect(firstCleanup).toBe(secondCleanup);
        expect(firstDestroy).toBe(secondDestroy);
        expect(cleanup).toHaveBeenCalledOnce();
        expect(destroy).not.toHaveBeenCalled();

        resolveCleanup?.();
        await Promise.all([
            firstCleanup,
            firstDestroy,
        ]);
        expect(destroy).toHaveBeenCalledOnce();
    });
});
