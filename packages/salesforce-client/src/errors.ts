export class SalesforceApiError extends Error {
    readonly statusCode: number;
    readonly errorCode?: string;
    readonly details?: unknown;

    constructor(message: string, opts: { statusCode: number; errorCode?: string; details?: unknown }) {
        super(message);
        this.name = "SalesforceApiError";
        this.statusCode = opts.statusCode;
        this.errorCode = opts.errorCode;
        this.details = opts.details;
    }
}

export function isSalesforceApiError(error: unknown): error is SalesforceApiError {
    return error instanceof SalesforceApiError;
}
