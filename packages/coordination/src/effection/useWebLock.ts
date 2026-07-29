import {
    resource,
    spawn,
    until,
    useAbortSignal,
    withResolvers,
    type Operation,
} from "effection";
import { normalizeError } from "../internal.js";

export type UseWebLockOptions = Omit<
    LockOptions,
    "signal"
>;

export function useWebLock(
    name: string,
    options: UseWebLockOptions = {}
): Operation<Lock | null> {
    return resource(function* (provide) {
        if (!globalThis.navigator?.locks) {
            throw new Error(
                "The Web Locks API is not available."
            );
        }
        const signal = yield* useAbortSignal();
        const acquired = withResolvers<Lock | null>(
            `acquire web lock: ${name}`
        );
        let release!: () => void;
        const hold = new Promise<void>((resolve) => {
            release = resolve;
        });
        const request = navigator.locks.request(
            name,
            {
                ...options,
                signal,
            },
            async (lock) => {
                acquired.resolve(lock);
                await hold;
            }
        );
        const task = yield* spawn(function* () {
            try {
                yield* until(request);
            } catch (error) {
                acquired.reject(normalizeError(error));
                throw error;
            }
        });

        try {
            const lock = yield* acquired.operation;
            yield* provide(lock);
        } finally {
            release();
            yield* task;
        }
    });
}
