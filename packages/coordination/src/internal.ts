import {
    CoordinationClosedError,
    CoordinationError,
    CoordinationServiceError,
    CoordinationTaskRejectedError,
    CoordinationTransportError,
    type CoordinationErrorCode,
} from "./contracts.js";

export interface Deferred<Value> {
    readonly promise: Promise<Value>;
    readonly settled: boolean;
    resolve(value: Value): void;
    reject(reason: unknown): void;
}

export function deferred<Value>(): Deferred<Value> {
    let settled = false;
    let resolvePromise!: (value: Value) => void;
    let rejectPromise!: (reason: unknown) => void;
    const promise = new Promise<Value>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });

    return {
        promise,
        get settled() {
            return settled;
        },
        resolve(value) {
            if (settled) return;
            settled = true;
            resolvePromise(value);
        },
        reject(reason) {
            if (settled) return;
            settled = true;
            rejectPromise(reason);
        },
    };
}

export function randomId(): string {
    const cryptoValue = globalThis.crypto;
    if (cryptoValue && "randomUUID" in cryptoValue) {
        return cryptoValue.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function normalizeError(reason: unknown): Error {
    if (reason instanceof Error) return reason;
    return new Error(
        typeof reason === "string" ? reason : String(reason)
    );
}

export function abortError(
    signal: AbortSignal,
    fallback = "Operation aborted."
): Error {
    if (signal.reason instanceof Error) return signal.reason;
    const error = new Error(
        typeof signal.reason === "string"
            ? signal.reason
            : fallback
    );
    error.name = "AbortError";
    return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortError(signal);
}

export function linkAbortSignal(
    source: AbortSignal | undefined,
    target: AbortController
): () => void {
    if (!source) return () => undefined;
    const abort = () => target.abort(source.reason);
    if (source.aborted) {
        abort();
        return () => undefined;
    }
    source.addEventListener("abort", abort, { once: true });
    return () => source.removeEventListener("abort", abort);
}

export function waitForAbortable<Value>(
    promise: PromiseLike<Value>,
    signal?: AbortSignal
): Promise<Value> {
    if (!signal) return Promise.resolve(promise);
    if (signal.aborted) return Promise.reject(abortError(signal));
    return new Promise<Value>((resolve, reject) => {
        const abort = () => reject(abortError(signal));
        signal.addEventListener("abort", abort, { once: true });
        void Promise.resolve(promise).then(
            (value) => {
                signal.removeEventListener("abort", abort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener("abort", abort);
                reject(normalizeError(error));
            }
        );
    });
}

export interface SerializedError {
    readonly name: string;
    readonly message: string;
    readonly code?: string;
}

export function serializeError(reason: unknown): SerializedError {
    const error = normalizeError(reason);
    const code =
        error instanceof CoordinationError ||
        error instanceof CoordinationTaskRejectedError
            ? error.code
            : undefined;
    return {
        name: error.name,
        message: error.message,
        code,
    };
}

const coordinationCodes = new Set<CoordinationErrorCode>([
    "ABORTED",
    "CLOSED",
    "CYCLIC_SERVICE_CALL",
    "DISCONNECTED",
    "DUPLICATE_SERVICE",
    "HANDLER_ERROR",
    "PROTOCOL_MISMATCH",
    "SERVICE_CLOSED",
    "SERVICE_UNAVAILABLE",
    "TIMEOUT",
    "TRANSPORT_ERROR",
]);

export function deserializeError(details: SerializedError): Error {
    if (
        details.name ===
            "CoordinationTaskRejectedError" &&
        details.code
    ) {
        return new CoordinationTaskRejectedError(
            details.message,
            details.code
        );
    }
    if (details.code === "CLOSED") {
        return new CoordinationClosedError(details.message);
    }
    if (
        details.code === "CYCLIC_SERVICE_CALL" ||
        details.code === "DUPLICATE_SERVICE" ||
        details.code === "HANDLER_ERROR" ||
        details.code === "SERVICE_CLOSED" ||
        details.code === "SERVICE_UNAVAILABLE"
    ) {
        return new CoordinationServiceError(
            details.message,
            details.code
        );
    }
    if (
        details.code === "DISCONNECTED" ||
        details.code === "TIMEOUT" ||
        details.code === "TRANSPORT_ERROR"
    ) {
        return new CoordinationTransportError(
            details.message,
            details.code
        );
    }
    const error =
        details.code && coordinationCodes.has(details.code as CoordinationErrorCode)
            ? new CoordinationError(
                  details.message,
                  details.code as CoordinationErrorCode
              )
            : new Error(details.message);
    error.name = details.name;
    return error;
}
