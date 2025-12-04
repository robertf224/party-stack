import type { Operation, Stream } from "effection";

// Temporarily copied from stream-helpers package until v4 support (https://github.com/thefrontside/effectionx/tree/main/stream-helpers)

/**
 * Transforms each item in the stream using the provided function.
 *
 * @param fn - The function to transform each item
 * @returns A stream transformer that applies the function to each item
 */
export function map<A, B>(
    fn: (value: A) => Operation<B>
): <TClose>(stream: Stream<A, TClose>) => Stream<B, TClose> {
    return function (stream) {
        return {
            *[Symbol.iterator]() {
                const subscription = yield* stream;

                return {
                    *next() {
                        const next = yield* subscription.next();
                        if (next.done) {
                            return next;
                        }

                        return {
                            done: false,
                            value: yield* fn(next.value),
                        };
                    },
                };
            },
        };
    };
}

/**
 * Filters items from the stream based on a predicate function.
 *
 * @param predicate - The function to test each item
 * @returns A stream transformer that only emits items that pass the predicate
 *
 * @example
 * ```typescript
 * import { filter } from "@effectionx/stream-helpers";
 * import { run, each } from "effection";
 *
 * await run(function* () {
 *   const stream = filter((x: number) => x > 5)(sourceStream);
 *
 *   for (const value of yield* each(stream)) {
 *     console.log(value); // Only values > 5
 *   }
 * });
 * ```
 */
export function filter<T>(
    predicate: (value: T) => Operation<boolean>
): <TDone>(stream: Stream<T, TDone>) => Stream<T, TDone> {
    return function (stream) {
        return {
            *[Symbol.iterator]() {
                const subscription = yield* stream;

                return {
                    *next() {
                        while (true) {
                            const next = yield* subscription.next();
                            if (next.done) {
                                return next;
                            }
                            if (yield* predicate(next.value)) {
                                return {
                                    done: false,
                                    value: next.value,
                                };
                            }
                        }
                    },
                };
            },
        };
    };
}
