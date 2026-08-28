const UNAUTHENTICATED_ERROR_CODE =
    "unauthenticated" as const;
const UNAUTHENTICATED_ERROR_NAME =
    "UnauthenticatedError" as const;

export class UnauthenticatedError extends Error {
    readonly code = UNAUTHENTICATED_ERROR_CODE;

    constructor(
        message = "Authentication is required.",
        options?: ErrorOptions
    ) {
        super(message, options);
        this.name = UNAUTHENTICATED_ERROR_NAME;
    }
}

export function unauthenticated(
    message?: string,
    options?: ErrorOptions
): UnauthenticatedError {
    return new UnauthenticatedError(message, options);
}

export function isUnauthenticatedError(
    error: unknown
): error is UnauthenticatedError {
    if (error instanceof UnauthenticatedError) return true;
    if (typeof error !== "object" || error === null) {
        return false;
    }
    const candidate = error as {
        name?: unknown;
        code?: unknown;
    };
    return (
        candidate.name === UNAUTHENTICATED_ERROR_NAME &&
        candidate.code === UNAUTHENTICATED_ERROR_CODE
    );
}
