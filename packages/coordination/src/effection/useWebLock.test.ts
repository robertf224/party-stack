import {
    run,
    suspend,
} from "effection";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { useWebLock } from "./useWebLock.js";

class TestLockManager implements LockManager {
    private readonly tails = new Map<
        string,
        Promise<unknown>
    >();

    request<T>(
        name: string,
        callback: (
            lock: Lock | null
        ) => T | PromiseLike<T>
    ): Promise<T>;
    request<T>(
        name: string,
        options: LockOptions,
        callback: (
            lock: Lock | null
        ) => T | PromiseLike<T>
    ): Promise<T>;
    request<T>(
        name: string,
        optionsOrCallback:
            | LockOptions
            | ((
                  lock: Lock | null
              ) => T | PromiseLike<T>),
        callback?: (
            lock: Lock | null
        ) => T | PromiseLike<T>
    ): Promise<T> {
        const options =
            typeof optionsOrCallback === "function"
                ? {}
                : optionsOrCallback;
        const grant =
            typeof optionsOrCallback === "function"
                ? optionsOrCallback
                : callback!;
        const operation = (
            this.tails.get(name) ??
            Promise.resolve()
        ).then(async () => {
            if (options.signal?.aborted) {
                throw (
                    options.signal.reason ??
                    new DOMException(
                        "The operation was aborted.",
                        "AbortError"
                    )
                );
            }
            return grant({
                mode: options.mode ?? "exclusive",
                name,
            } as Lock);
        });
        this.tails.set(
            name,
            operation.catch(() => undefined)
        );
        return operation;
    }

    query(): Promise<LockManagerSnapshot> {
        return Promise.resolve({
            held: [],
            pending: [],
        });
    }
}

let navigatorDescriptor:
    | PropertyDescriptor
    | undefined;

beforeEach(() => {
    navigatorDescriptor =
        Object.getOwnPropertyDescriptor(
            globalThis,
            "navigator"
        );
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            ...(globalThis.navigator ?? {}),
            locks: new TestLockManager(),
        },
    });
});

afterEach(() => {
    if (navigatorDescriptor) {
        Object.defineProperty(
            globalThis,
            "navigator",
            navigatorDescriptor
        );
    } else {
        Reflect.deleteProperty(
            globalThis,
            "navigator"
        );
    }
});

describe("useWebLock", () => {
    it("holds the native lock for its resource scope", async () => {
        let resolveFirst!: () => void;
        const firstAcquired = new Promise<void>(
            (resolve) => {
                resolveFirst = resolve;
            }
        );
        const secondAcquired = vi.fn();
        const first = run(function* () {
            const lock = yield* useWebLock(
                "resource-lock"
            );
            expect(lock?.name).toBe("resource-lock");
            resolveFirst();
            yield* suspend();
        });
        await firstAcquired;
        const second = run(function* () {
            yield* useWebLock("resource-lock");
            secondAcquired();
        });

        await Promise.resolve();
        expect(secondAcquired).not.toHaveBeenCalled();
        await first.halt();
        await second;
        expect(secondAcquired).toHaveBeenCalledOnce();
    });
});
