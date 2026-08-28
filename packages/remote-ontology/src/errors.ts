import { z } from "zod";

export type RemoteOntologyErrorCode =
    | "FORBIDDEN"
    | "VALIDATION"
    | "NOT_FOUND"
    | "BAD_REQUEST"
    | "BACKEND"
    | "INTERNAL";

export interface RemoteOntologyErrorDetails {
    parameters?: Record<string, unknown>;
    validation?: unknown;
    [key: string]: unknown;
}

export interface RemoteOntologyErrorEnvelope {
    v: 1;
    name: string;
    code: RemoteOntologyErrorCode;
    status: number;
    message: string;
    retryable: boolean;
    details?: RemoteOntologyErrorDetails;
}

export const remoteOntologyErrorEnvelopeSchema = z
    .object({
        v: z.literal(1),
        name: z.string().min(1),
        code: z.enum(["FORBIDDEN", "VALIDATION", "NOT_FOUND", "BAD_REQUEST", "BACKEND", "INTERNAL"]),
        status: z.number().int().positive(),
        message: z.string(),
        retryable: z.boolean(),
        details: z.record(z.string(), z.unknown()).optional(),
    })
    .strict() satisfies z.ZodType<RemoteOntologyErrorEnvelope>;

export class RemoteOntologyError extends Error {
    readonly code: RemoteOntologyErrorCode;
    readonly status: number;
    readonly retryable: boolean;
    readonly details?: RemoteOntologyErrorDetails;

    constructor(opts: {
        name?: string;
        code: RemoteOntologyErrorCode;
        status: number;
        message: string;
        retryable?: boolean;
        details?: RemoteOntologyErrorDetails;
        cause?: unknown;
    }) {
        super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
        this.name = opts.name ?? "RemoteOntologyError";
        this.code = opts.code;
        this.status = opts.status;
        this.retryable = opts.retryable ?? defaultRetryable(opts.code, opts.status);
        this.details = opts.details;
    }

    toJSON(): RemoteOntologyErrorEnvelope {
        return {
            v: 1,
            name: this.name,
            code: this.code,
            status: this.status,
            message: this.message,
            retryable: this.retryable,
            ...(this.details ? { details: this.details } : {}),
        };
    }

    static fromEnvelope(envelope: RemoteOntologyErrorEnvelope): RemoteOntologyError {
        return new RemoteOntologyError({
            name: envelope.name,
            code: envelope.code,
            status: envelope.status,
            message: envelope.message,
            retryable: envelope.retryable,
            details: envelope.details,
        });
    }
}

function defaultRetryable(code: RemoteOntologyErrorCode, status: number): boolean {
    if (code === "FORBIDDEN" || code === "VALIDATION" || code === "NOT_FOUND" || code === "BAD_REQUEST") {
        return false;
    }
    return status >= 500;
}

export function isRemoteOntologyErrorEnvelope(value: unknown): value is RemoteOntologyErrorEnvelope {
    return remoteOntologyErrorEnvelopeSchema.safeParse(value).success;
}

export function parseRemoteOntologyErrorBody(
    text: string,
    status: number
): RemoteOntologyError {
    if (!text) {
        return new RemoteOntologyError({
            code: statusToCode(status),
            status,
            message: `Remote ontology request failed with status ${status}.`,
        });
    }

    try {
        const parsed: unknown = JSON.parse(text);
        if (isRemoteOntologyErrorEnvelope(parsed)) {
            return RemoteOntologyError.fromEnvelope(parsed);
        }
        if (
            typeof parsed === "object" &&
            parsed !== null &&
            "error" in parsed &&
            typeof (parsed as { error: unknown }).error === "string"
        ) {
            // Legacy `{ error: string }` compatibility.
            return new RemoteOntologyError({
                code: statusToCode(status),
                status,
                message: (parsed as { error: string }).error,
            });
        }
    } catch {
        // Fall through to raw text.
    }

    return new RemoteOntologyError({
        code: statusToCode(status),
        status,
        message: text,
    });
}

export function statusToCode(status: number): RemoteOntologyErrorCode {
    if (status === 403) return "FORBIDDEN";
    if (status === 404) return "NOT_FOUND";
    if (status === 422) return "VALIDATION";
    if (status >= 400 && status < 500) {
        return "BAD_REQUEST";
    }
    if (status >= 500) return "INTERNAL";
    return "BACKEND";
}

export function remoteOntologyErrorFromUnknown(error: unknown): RemoteOntologyError {
    if (error instanceof RemoteOntologyError) return error;

    if (error instanceof Error && error.name === "RemoteOntologyForbiddenError") {
        return new RemoteOntologyError({
            name: "RemoteOntologyForbiddenError",
            code: "FORBIDDEN",
            status: 403,
            message: error.message,
            retryable: false,
        });
    }

    if (error instanceof Error && error.name === "ZodError") {
        return new RemoteOntologyError({
            name: "ZodError",
            code: "BAD_REQUEST",
            status: 400,
            message: error.message,
            retryable: false,
            details: {
                validation: "issues" in error ? (error as { issues: unknown }).issues : undefined,
            },
        });
    }

    if (error instanceof Error && error.name === "NonRetryableError") {
        const message = error.message.toLowerCase();
        if (message.includes("not found")) {
            return new RemoteOntologyError({
                name: error.name,
                code: "NOT_FOUND",
                status: 404,
                message: error.message,
                retryable: false,
                cause: error,
            });
        }
        if (message.includes("invalid")) {
            return new RemoteOntologyError({
                name: error.name,
                code: "VALIDATION",
                status: 400,
                message: error.message,
                retryable: false,
                cause: error,
            });
        }
        return new RemoteOntologyError({
            name: error.name,
            code: "BACKEND",
            status: 400,
            message: error.message,
            retryable: false,
            cause: error,
        });
    }

    const message = error instanceof Error ? error.message : String(error);
    // Sanitize potential sensitive backend details from unexpected failures.
    const safeMessage =
        message.length > 500 ? "Remote ontology request failed." : message || "Remote ontology request failed.";
    return new RemoteOntologyError({
        name: error instanceof Error ? error.name : "RemoteOntologyError",
        code: "INTERNAL",
        status: 500,
        message: safeMessage,
        retryable: true,
        cause: error,
    });
}
