import {
    race,
    type Operation,
    type Scope,
} from "effection";
import {
    normalizeError,
} from "../internal.js";
import { waitForAbort } from "./waitForAbort.js";

export function runInScope<Result>(
    scope: Scope,
    operation: () => Operation<Result>,
    signals: readonly (
        | AbortSignal
        | undefined
    )[] = []
): Promise<Result> {
    const task = scope.run(function* () {
        const aborts = signals
            .filter(
                (
                    signal
                ): signal is AbortSignal =>
                    signal !== undefined
            )
            .map(waitForAbort);
        try {
            const value =
                aborts.length === 0
                    ? yield* operation()
                    : yield* race([
                          operation(),
                          ...aborts,
                      ]);
            return {
                ok: true as const,
                value,
            };
        } catch (error) {
            return {
                ok: false as const,
                error: normalizeError(error),
            };
        }
    });
    return task.then((result) => {
        if (result.ok) return result.value;
        throw result.error;
    });
}
