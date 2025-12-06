import { each, type Operation, type Stream } from "effection";

// Copied/adapted from https://github.com/thefrontside/effectionx/blob/main/signals/types.ts

/**
 * A signal is a stream with set, update, and valueOf methods.
 * Subscribing to a signal will yield the current value of the signal.
 */
export interface ValueSignal<T> extends Stream<T, void> {
    /**
     * Set the value of the signal.
     * @param value - The value to set the signal to.
     * @returns The value of the signal.
     */
    set(value: T): T;
    /**
     * Update the value of the signal.
     * @param updater - The updater function.
     * @returns The value of the signal.
     */
    update(updater: (value: T) => T): T;
    /**
     * Get the current value of the signal.
     * @returns The current value of the signal.
     */
    valueOf(): T;
}

/**
 * Returns an operation that will wait until the value of the stream matches the predicate.
 * @param stream - The stream to check.
 * @param predicate - The predicate to check the value against.
 * @returns An operation that will wait until the value of the stream matches the predicate.
 */
export function* is<T>(stream: ValueSignal<T>, predicate: (item: T) => boolean): Operation<void> {
    const result = predicate(stream.valueOf());
    if (result) {
        return;
    }
    for (const value of yield* each(stream)) {
        const result = predicate(value);
        if (result) {
            return;
        }
        yield* each.next();
    }
}
