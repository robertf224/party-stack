export class FoundryError extends Error {
    readonly statusCode?: number;
    readonly errorCode?: string;
    readonly errorName?: string;
    readonly errorInstanceId?: string;
    readonly parameters?: Record<string, unknown>;

    constructor(
        message: string,
        opts?: {
            statusCode?: number;
            errorCode?: string;
            errorName?: string;
            errorInstanceId?: string;
            parameters?: Record<string, unknown>;
            cause?: unknown;
        }
    ) {
        super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
        this.name = "FoundryError";
        this.statusCode = opts?.statusCode;
        this.errorCode = opts?.errorCode;
        this.errorName = opts?.errorName;
        this.errorInstanceId = opts?.errorInstanceId;
        this.parameters = opts?.parameters;
    }
}

export class FoundryActionValidationError extends FoundryError {
    readonly validation?: unknown;

    constructor(
        message: string,
        opts?: {
            statusCode?: number;
            errorCode?: string;
            errorName?: string;
            errorInstanceId?: string;
            parameters?: Record<string, unknown>;
            validation?: unknown;
            cause?: unknown;
        }
    ) {
        super(message, {
            statusCode: opts?.statusCode,
            errorCode: opts?.errorCode ?? "INVALID_ARGUMENT",
            errorName: opts?.errorName ?? "ActionValidationError",
            errorInstanceId: opts?.errorInstanceId,
            parameters: opts?.parameters,
            cause: opts?.cause,
        });
        this.name = "FoundryActionValidationError";
        this.validation = opts?.validation;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asParameters(value: unknown): Record<string, unknown> | undefined {
    return isRecord(value) ? value : undefined;
}

function readErrorFields(
    error: unknown,
    seen: Set<object> = new Set()
): {
    message?: string;
    statusCode?: number;
    errorCode?: string;
    errorName?: string;
    errorInstanceId?: string;
    parameters?: Record<string, unknown>;
    validation?: unknown;
} {
    if (!isRecord(error)) {
        return {};
    }
    if (seen.has(error)) {
        return {};
    }
    seen.add(error);

    const causeFields = readErrorFields(error.cause, seen);

    return {
        message: asString(error.message) ?? causeFields.message,
        statusCode:
            asNumber(error.statusCode) ??
            asNumber(error.status) ??
            causeFields.statusCode,
        errorCode:
            asString(error.errorCode) ??
            asString(error.code) ??
            causeFields.errorCode,
        errorName:
            asString(error.errorName) ??
            causeFields.errorName ??
            (asString(error.name) === "Error" ? undefined : asString(error.name)),
        errorInstanceId:
            asString(error.errorInstanceId) ??
            asString(error.instanceId) ??
            causeFields.errorInstanceId,
        parameters: asParameters(error.parameters) ?? causeFields.parameters,
        validation:
            error.validation ??
            error.actionValidation ??
            causeFields.validation,
    };
}

function isActionValidationLike(error: unknown, fields: ReturnType<typeof readErrorFields>): boolean {
    if (error instanceof FoundryActionValidationError) {
        return true;
    }
    if (!isRecord(error)) {
        return false;
    }
    const name = fields.errorName ?? asString(error.name);
    if (name === "ActionValidationError" || name === "FoundryActionValidationError") {
        return true;
    }
    if (fields.errorCode === "INVALID_ARGUMENT" && fields.validation !== undefined) {
        return true;
    }
    return fields.validation !== undefined && asString(error.name) === "ActionValidationError";
}

/**
 * Structurally normalizes Foundry/OSDK errors into Party Stack-owned error types.
 * Does not rely on `instanceof` against OSDK classes (which can fail across package copies).
 */
export function normalizeFoundryError(error: unknown): FoundryError {
    if (error instanceof FoundryError) {
        return error;
    }

    const fields = readErrorFields(error);
    const message =
        fields.message ??
        (typeof error === "string" && error.length > 0 ? error : "Unknown Foundry error.");

    if (isActionValidationLike(error, fields)) {
        return new FoundryActionValidationError(message, {
            statusCode: fields.statusCode,
            errorCode: fields.errorCode,
            errorName: fields.errorName,
            errorInstanceId: fields.errorInstanceId,
            parameters: fields.parameters,
            validation: fields.validation,
            cause: error,
        });
    }

    return new FoundryError(message, {
        statusCode: fields.statusCode,
        errorCode: fields.errorCode,
        errorName: fields.errorName,
        errorInstanceId: fields.errorInstanceId,
        parameters: fields.parameters,
        cause: error,
    });
}

export function isFoundryNotFoundError(error: unknown): boolean {
    const normalized = normalizeFoundryError(error);
    return normalized.statusCode === 404 || normalized.errorCode === "NOT_FOUND";
}

export function isFoundryAuthError(error: unknown): boolean {
    const normalized = normalizeFoundryError(error);
    return (
        normalized.statusCode === 401 ||
        normalized.statusCode === 403 ||
        normalized.errorCode === "UNAUTHORIZED" ||
        normalized.errorCode === "PERMISSION_DENIED"
    );
}
