import { Effect } from "effect";
import { deferred, normalizeError } from "../internal.js";

/** Holds a native Web Lock until the acquisition scope closes. */
export const webLock = Effect.fnUntraced(function* (name: string, options: Omit<LockOptions, "signal"> = {}) {
    const resource = yield* Effect.acquireRelease(
        Effect.try({
            try: () => {
                if (!globalThis.navigator?.locks) throw new Error("The Web Locks API is not available.");
                const controller = new AbortController();
                const acquired = deferred<Lock | null>();
                const hold = deferred<void>();
                let granted = false;
                const request = navigator.locks.request(
                    name,
                    { ...options, signal: controller.signal },
                    async (lock) => {
                        granted = true;
                        acquired.resolve(lock);
                        await hold.promise;
                    }
                );
                void request.catch((error: unknown) => acquired.reject(normalizeError(error)));
                void acquired.promise.catch(() => undefined);
                return {
                    controller,
                    acquired,
                    hold,
                    request,
                    get granted() {
                        return granted;
                    },
                };
            },
            catch: normalizeError,
        }),
        (resource) =>
            Effect.promise(async () => {
                resource.controller.abort();
                resource.hold.resolve();
                if (resource.granted) await resource.request.catch(() => undefined);
            })
    );
    return yield* Effect.tryPromise({ try: () => resource.acquired.promise, catch: normalizeError });
});
