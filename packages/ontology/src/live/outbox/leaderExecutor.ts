import {
    CoordinationTaskRejectedError,
    type CoordinationServiceClient,
    type RuntimeAdapter,
} from "@party-stack/runtime";
import {
    race,
    run,
    sleep,
    until,
    useAbortSignal,
    type Operation,
    type Stream,
    type Task,
} from "effection";
import { NonRetryableError, type OntologyOutboxEntry } from "./types.js";
import type { OutboxCoordinationService } from "./service.js";

export interface OutboxLeaderOptions {
    runtime: RuntimeAdapter;
    service: CoordinationServiceClient<OutboxCoordinationService>;
    wake: Stream<void, never>;
    failureStrategy: "pause" | "discard-all";
    maxRetries: number;
    retryDelayMs: number;
    execute(entry: OntologyOutboxEntry): Promise<unknown>;
}

function normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function isStaleExecution(error: unknown): boolean {
    return error instanceof CoordinationTaskRejectedError && error.code === "STALE_EXECUTION";
}

function retryDelay(
    baseDelayMs: number,
    retryIndex: number
): number {
    return Math.min(
        Number.MAX_SAFE_INTEGER,
        baseDelayMs *
            2 ** Math.min(retryIndex, 16)
    );
}

function isConnected(
    runtime: RuntimeAdapter
): boolean {
    return (
        runtime.connectivity?.isConnected !== false
    );
}

export function useOutboxLeader(options: OutboxLeaderOptions): Operation<void> {
    return (function* () {
        const signal = yield* useAbortSignal();
        yield* until(
            options.service.methods.recover({
                failureStrategy:
                    options.failureStrategy,
                maxRetries:
                    options.maxRetries,
            })
        );
        const wakes = yield* options.wake;

        while (true) {
            if (isConnected(options.runtime)) {
                while (true) {
                    if (!isConnected(options.runtime)) {
                        break;
                    }
                    const entry = yield* until(options.service.methods.claim({}));
                    if (!entry) {
                        const retryAt = yield* until(
                            options.service.methods.nextRetryAt(
                                {}
                            )
                        );
                        if (retryAt === undefined) {
                            break;
                        }
                        const delay = Math.max(
                            0,
                            retryAt - Date.now()
                        );
                        if (delay > 0) {
                            yield* race([
                                sleep(delay),
                                wakes.next(),
                            ]);
                        }
                        continue;
                    }
                    const executionId = entry.executionId!;

                    let result: unknown;
                    try {
                        result = yield* until(options.execute(entry));
                    } catch (error) {
                        if (signal.aborted) throw error;
                        const normalized = normalizeError(error);
                        const retryable = !(normalized instanceof NonRetryableError);
                        const retryScheduled =
                            retryable &&
                            entry.attempts <
                                options.maxRetries;
                        try {
                            const errorDetails = {
                                name: normalized.name,
                                message:
                                    normalized.message,
                            };
                            if (retryScheduled) {
                                yield* until(
                                    options.service.methods.fail({
                                        id: entry.id,
                                        executionId,
                                        retryable: true,
                                        retryAt:
                                            Date.now() +
                                            retryDelay(
                                                options.retryDelayMs,
                                                entry.attempts
                                            ),
                                        error: errorDetails,
                                    })
                                );
                            } else if (
                                options.failureStrategy ===
                                    "discard-all"
                            ) {
                                yield* until(
                                    options.service.methods.discardAll(
                                        {
                                            id: entry.id,
                                            executionId,
                                            error: errorDetails,
                                        }
                                    )
                                );
                            } else {
                                yield* until(
                                    options.service.methods.fail({
                                        id: entry.id,
                                        executionId,
                                        retryable,
                                        error: errorDetails,
                                    })
                                );
                            }
                        } catch (claimError) {
                            if (isStaleExecution(claimError)) {
                                break;
                            }
                            throw claimError;
                        }
                        if (retryScheduled) {
                            continue;
                        }
                        break;
                    }

                    if (signal.aborted) {
                        throw signal.reason;
                    }
                    try {
                        yield* until(
                            options.service.methods.complete({
                                id: entry.id,
                                executionId,
                                result,
                            })
                        );
                    } catch (error) {
                        if (isStaleExecution(error)) break;
                        throw error;
                    }
                }
            }

            yield* wakes.next();
        }
    })();
}

export async function runOutboxLeader(signal: AbortSignal, options: OutboxLeaderOptions): Promise<void> {
    const task: Task<void> = run(() => useOutboxLeader(options));
    let halt: Promise<void> | undefined;
    const haltTask = () => {
        halt ??= Promise.resolve(task.halt()).then(() => undefined);
    };
    signal.addEventListener("abort", haltTask, {
        once: true,
    });
    if (signal.aborted) haltTask();

    try {
        await task;
    } finally {
        signal.removeEventListener("abort", haltTask);
        haltTask();
        await halt;
    }
}
