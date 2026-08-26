import type { ConnectionEgressHandlers } from "./types.js";

const RETRY_STATUSES = new Set([429, 503]);

export interface HttpRetryHandlingOptions {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const abort = () => {
            clearTimeout(timeout);
            reject(
                signal.reason instanceof Error
                    ? signal.reason
                    : new Error("Sleep was aborted.", {
                          cause: signal.reason,
                      })
            );
        };
        const timeout = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, milliseconds);
        if (signal.aborted) {
            abort();
            return;
        }
        signal.addEventListener("abort", abort, {
            once: true,
        });
    });
}

function retryAfterMs(response: Response): number | undefined {
    const value = response.headers.get("Retry-After");
    if (!value) return;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) {
        return Math.max(0, seconds * 1_000);
    }
    const date = Date.parse(value);
    return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function withHttpRetryHandling(
    handlers: ConnectionEgressHandlers,
    options: HttpRetryHandlingOptions = {}
): ConnectionEgressHandlers {
    const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    const baseDelayMs = options.baseDelayMs ?? 250;
    const maxDelayMs = options.maxDelayMs ?? 10_000;
    return {
        ...handlers,
        async fetch(request) {
            const template = request.clone();
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                const current = attempt === 1 ? request : template.clone();
                const response = await handlers.fetch(current);
                if (attempt === maxAttempts || !RETRY_STATUSES.has(response.status)) {
                    return response;
                }
                const exponential = baseDelayMs * 2 ** (attempt - 1);
                const delay =
                    retryAfterMs(response) ?? Math.min(maxDelayMs, exponential * (0.5 + Math.random() * 0.5));
                await sleep(delay, request.signal);
            }
            throw new Error("HTTP retry loop terminated unexpectedly.");
        },
    };
}
