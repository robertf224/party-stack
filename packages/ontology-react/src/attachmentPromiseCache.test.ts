import { afterEach, expect, test, vi } from "vite-plus/test";
import { AttachmentPromiseCache } from "./attachmentPromiseCache.js";

function deferred<A>() {
    let resolve!: (value: A) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<A>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

test("one stable Promise serves suspended readers and shared committed consumers", async () => {
    vi.useFakeTimers();
    const cache = new AttachmentPromiseCache(1_000);
    const pending = deferred<string>();
    const open = vi.fn(() => pending.promise);
    const close = vi.fn();
    const entry = cache.get("url/a", open, close);
    expect(cache.get("url/a", open, close)).toBe(entry);
    await Promise.resolve();
    expect(open).toHaveBeenCalledTimes(1);
    pending.resolve("blob:a");
    await expect(entry.promise).resolves.toBe("blob:a");
    const first = cache.subscribe(entry, () => {});
    const second = cache.subscribe(entry, () => {});
    first();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(close).not.toHaveBeenCalled();
    second();
    await vi.advanceTimersByTimeAsync(999);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledExactlyOnceWith("blob:a");
    expect(cache.get("url/a", open, close)).not.toBe(entry);
    cache.dispose();
});

test("StrictMode's immediate release and reacquire preserves the same URL", async () => {
    vi.useFakeTimers();
    const cache = new AttachmentPromiseCache(1_000);
    const close = vi.fn();
    const entry = cache.get("url/a", async () => "blob:a", close);
    await entry.promise;
    cache.subscribe(entry, () => {})();
    const stop = cache.subscribe(entry, () => {});
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cache.get("url/a", async () => "other", close)).toBe(entry);
    expect(close).not.toHaveBeenCalled();
    stop();
    cache.dispose();
    cache.dispose();
    expect(close).toHaveBeenCalledExactlyOnceWith("blob:a");
});

test("owner disposal aborts a pending abandoned read and releases a late result", async () => {
    const cache = new AttachmentPromiseCache();
    const pending = deferred<string>();
    let signal!: AbortSignal;
    const close = vi.fn();
    const entry = cache.get(
        "url/a",
        (value) => {
            signal = value;
            return pending.promise;
        },
        close
    );
    await Promise.resolve();
    cache.dispose();
    expect(signal.aborted).toBe(true);
    pending.resolve("blob:late");
    await expect(entry.promise).rejects.toMatchObject({ name: "AbortError" });
    expect(close).toHaveBeenCalledExactlyOnceWith("blob:late");
    expect(() => cache.get("url/a", async () => "x")).toThrow("closed");
});

test("initial failures remain stable for error boundaries until explicit owner reset or inactive GC", async () => {
    vi.useFakeTimers();
    const cache = new AttachmentPromiseCache(1_000);
    const failure = new Error("Unavailable");
    const open = vi.fn(async () => {
        throw failure;
    });
    const entry = cache.get("metadata/a", open);
    await expect(entry.promise).rejects.toBe(failure);
    expect(cache.get("metadata/a", open)).toBe(entry);
    expect(open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    const retried = cache.get("metadata/a", async () => ({ size: 12 }));
    expect(retried).not.toBe(entry);
    await expect(retried.promise).resolves.toEqual({ size: 12 });
    cache.dispose();
    const reset = new AttachmentPromiseCache();
    await expect(reset.get("metadata/a", async () => ({ size: 24 })).promise).resolves.toEqual({ size: 24 });
    reset.dispose();
});
