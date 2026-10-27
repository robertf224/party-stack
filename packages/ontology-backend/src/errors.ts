import { Predicate, Schema, SchemaIssue, Redacted } from "effect";
import type { ValidationIssue } from "@party-stack/ontology-spec";

export type { ValidationIssue };
export const ValidationIssueSchema = Schema.Struct({
    message: Schema.String,
    path: Schema.optional(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
    code: Schema.optional(Schema.String),
    category: Schema.optional(Schema.Literals(["input", "reference", "custom"])),
    source: Schema.optional(Schema.Literals(["parameter", "submission", "user-facing"])),
    messageSource: Schema.optional(Schema.Literals(["standard", "configured"])),
});
export const ValidationReportSchema = Schema.Union([
    Schema.Struct({ certain: Schema.Literal(false) }),
    Schema.Struct({
        certain: Schema.Literal(true),
        value: Schema.Union([
            Schema.Struct({ kind: Schema.Literal("ok"), value: Schema.Void }),
            Schema.Struct({ kind: Schema.Literal("err"), value: Schema.Array(ValidationIssueSchema) }),
        ]),
    }),
]);
export type ValidationReport = typeof ValidationReportSchema.Type;

export const BackendErrorKindSchema = Schema.Literals([
    "Unauthenticated",
    "Forbidden",
    "NotFound",
    "ValidationFailed",
    "Conflict",
    "NotImplemented",
    "RateLimited",
    "Unavailable",
    "Internal",
    "HistoryExpired",
    "SessionExpired",
    "SessionReplaced",
    "ViewReplaced",
    "ResultExpired",
    "SourceMismatch",
    "SchemaMismatch",
]);
export type BackendErrorKind = typeof BackendErrorKindSchema.Type;
const Fields = {
    operation: Schema.String,
    kind: BackendErrorKindSchema,
    message: Schema.String,
    retryable: Schema.Boolean,
    actionOutcome: Schema.optional(Schema.Literals(["not-committed", "unknown"])),
    retryAfterMs: Schema.optional(Schema.Finite),
    issues: Schema.optional(Schema.Array(ValidationIssueSchema)),
    cause: Schema.optional(Schema.Defect()),
};
/** Shared wire schema; hooks narrow the kind without duplicating error classes. */
export class BackendError<
    K extends BackendErrorKind = BackendErrorKind,
> extends Schema.TaggedError<BackendError>()("BackendError", Fields) {
    declare readonly kind: K;
    constructor(properties: Omit<Schema.Struct.Type<typeof Fields>, "kind"> & { readonly kind: K }) {
        super(properties);
    }
}
export type OperationErrorKind =
    | "Unauthenticated"
    | "Forbidden"
    | "NotFound"
    | "ValidationFailed"
    | "Conflict"
    | "NotImplemented"
    | "RateLimited"
    | "Unavailable"
    | "Internal";
export type ApplyActionError = BackendError<OperationErrorKind>;
export type ValidateActionError = BackendError<OperationErrorKind>;
export type LoadSubsetError = BackendError<OperationErrorKind | "HistoryExpired">;

export const unauthenticated = (message = "Authentication is required.", options?: ErrorOptions) =>
    new BackendError({
        operation: "authentication",
        kind: "Unauthenticated",
        message,
        retryable: false,
        actionOutcome: "not-committed",
        cause: options?.cause,
    });
export const isUnauthenticatedError = (error: unknown): error is BackendError<"Unauthenticated"> =>
    error instanceof BackendError && error.kind === "Unauthenticated";

/** Unknown outcomes apply to dispatch/execution failures, never ordinary rejections. */
export const isUnknownActionOutcome = (error: BackendError) =>
    error.actionOutcome === "unknown" ||
    (error.actionOutcome === undefined && (error.kind === "Unavailable" || error.kind === "Internal"));

const ProviderFailure = Schema.Struct({
    reason: Schema.optional(Schema.Unknown),
    cause: Schema.optional(Schema.Unknown),
    response: Schema.optional(
        Schema.Struct({
            status: Schema.Number,
            headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
        })
    ),
    retryAfterMs: Schema.optional(Schema.Finite),
    status: Schema.optional(Schema.Number),
    statusCode: Schema.optional(Schema.Number),
    errorCode: Schema.optional(Schema.String),
    errorName: Schema.optional(Schema.String),
    code: Schema.optional(Schema.String),
    parameters: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
/** Normalize SDK failures. No provider message/body is made public by this classifier. */
export function classifyBackendFailure(operation: string, cause: unknown): BackendError {
    if (cause instanceof BackendError) return cause;
    let candidate = cause;
    let value: typeof ProviderFailure.Type | undefined;
    for (let depth = 0; depth < 5; depth++) {
        if (candidate instanceof BackendError) return candidate;
        const decoded = Schema.decodeUnknownOption(ProviderFailure)(candidate);
        if (decoded._tag === "None") break;
        value = decoded.value;
        if (
            value.status !== undefined ||
            value.statusCode !== undefined ||
            value.errorCode !== undefined ||
            value.code !== undefined ||
            value.errorName !== undefined ||
            value.response
        )
            break;
        candidate = value.reason ?? value.cause;
    }
    const status = value?.status ?? value?.statusCode ?? value?.response?.status;
    const code = value?.errorCode ?? value?.code;
    const name = value?.errorName?.split(":").at(-1);
    const kind: OperationErrorKind =
        status === 501
            ? "NotImplemented"
            : status === 401 || code === "UNAUTHORIZED" || code === "INVALID_SESSION_ID"
              ? "Unauthenticated"
              : status === 429 || code === "REQUEST_LIMIT_EXCEEDED" || name === "RateLimitReached"
                ? "RateLimited"
                : status === 403 || code === "PERMISSION_DENIED" || code === "INSUFFICIENT_ACCESS_OR_READONLY"
                  ? "Forbidden"
                  : status === 404 || code === "NOT_FOUND"
                    ? "NotFound"
                    : name === "FunctionEncounteredUserFacingError" ||
                        name === "QueryEncounteredUserFacingError"
                      ? "ValidationFailed"
                      : status === 400 ||
                          code === "INVALID_ARGUMENT" ||
                          code === "FIELD_CUSTOM_VALIDATION_EXCEPTION" ||
                          code === "REQUIRED_FIELD_MISSING"
                        ? "ValidationFailed"
                        : status === 409
                          ? "Conflict"
                          : "Unavailable";
    const authored =
        name === "FunctionEncounteredUserFacingError" || name === "QueryEncounteredUserFacingError";
    const issues: readonly ValidationIssue[] | undefined =
        authored && Predicate.isString(value?.parameters?.message)
            ? [
                  {
                      message: value.parameters.message,
                      code: "custom",
                      category: "custom",
                      source: "user-facing",
                      messageSource: "configured",
                  },
              ]
            : undefined;
    const seconds = value?.response?.headers?.["retry-after"];
    const retryAfterMs =
        value?.retryAfterMs ??
        (seconds !== undefined && /^\d+(?:\.\d+)?$/.test(seconds) ? Number(seconds) * 1_000 : undefined);
    return new BackendError({
        operation,
        kind,
        retryAfterMs,
        message: {
            Unauthenticated: "Authentication is required.",
            Forbidden: "This operation is not permitted.",
            NotFound: "Resource not found.",
            ValidationFailed: "Submission failed validation.",
            Conflict: "The operation conflicts with current state.",
            NotImplemented: "This operation is not implemented.",
            RateLimited: "Too many requests. Try again later.",
            Unavailable: "The service is unavailable. Try again later.",
            Internal: "The operation could not be completed.",
        }[kind],
        retryable: kind === "Unavailable" || kind === "RateLimited",
        actionOutcome: kind === "Unavailable" ? "unknown" : "not-committed",
        issues,
        cause: Redacted.make(cause),
    });
}

export interface ErrorProjectionContext {
    /** Visible action parameter paths. Hidden/fixed parameters must not appear in public issues. */
    readonly parameters?: readonly string[];
    readonly objectReferenceParameters?: readonly string[];
    /** An upstream connection failure cannot request downstream sign-in. */
    readonly upstream?: boolean;
}
export type ErrorProjection =
    | "forward"
    | "projected"
    | ((error: BackendError, context: ErrorProjectionContext) => BackendError);
export function projectValidationIssue(
    issue: ValidationIssue,
    context: ErrorProjectionContext
): ValidationIssue | undefined {
    const parameter = issue.path?.[0];
    if (!Predicate.isString(parameter) || !context.parameters?.includes(parameter)) return undefined;
    if (issue.category === "input") {
        const standard: Readonly<Record<string, string>> = {
            required: "A value is required.",
            type: "Enter a valid value.",
            range: "Enter a value in the allowed range.",
            arraySize: "Choose an allowed number of items.",
            stringLength: "Enter a value of the allowed length.",
            regex: "Enter a value in the required format.",
        };
        const message = issue.messageSource === "standard" ? issue.message : standard[issue.code ?? ""];
        if (message)
            return {
                message,
                path: issue.path,
                code: issue.code,
                category: "input",
                messageSource: "standard",
            };
    }
    if (issue.code === "InvalidObjectReference")
        return { message: "Choose a valid value.", path: issue.path, code: "InvalidObjectReference" };
    return undefined;
}
/** Always removes raw causes. Custom projection cannot change execution/retry facts. */
export function projectBackendError(
    error: BackendError,
    policy: ErrorProjection = "projected",
    context: ErrorProjectionContext = {}
): BackendError {
    const shown = typeof policy === "function" ? policy(error, context) : error;
    const kind = error.kind === "Unauthenticated" && context.upstream ? "Unavailable" : shown.kind;
    const issues =
        policy === "projected"
            ? error.issues?.flatMap((issue) => {
                  const visible = projectValidationIssue(issue, context);
                  return visible ? [visible] : [];
              })
            : shown.issues;
    const message =
        policy !== "projected"
            ? shown.message
            : kind === "ValidationFailed"
              ? "Submission failed validation."
              : kind === "Unauthenticated"
                ? "Authentication is required."
                : kind === "Forbidden"
                  ? "This operation is not permitted."
                  : kind === "NotFound"
                    ? "Resource not found."
                    : kind === "RateLimited"
                      ? "Too many requests. Try again later."
                      : kind === "NotImplemented"
                        ? "This operation is not implemented."
                        : "The operation could not be completed.";
    return new BackendError({
        operation: error.operation,
        kind,
        message,
        issues: issues?.length ? issues : undefined,
        retryable: error.retryable,
        actionOutcome: error.actionOutcome,
        retryAfterMs: error.retryAfterMs,
    });
}
export type UnauthenticatedError = BackendError<"Unauthenticated">;

/** Schema diagnostics retain paths without echoing input values or internal schemas. */
export function schemaValidationIssues(error: Schema.SchemaError): readonly ValidationIssue[] {
    return SchemaIssue.makeFormatterStandardSchemaV1({
        leafHook: (issue) => (issue._tag === "MissingKey" ? "A value is required." : "Enter a valid value."),
        checkHook: () => "Enter a valid value.",
    })(error.issue).issues.map((issue) => ({
        message: issue.message,
        path: issue.path?.flatMap((part) =>
            typeof part === "string" || typeof part === "number" ? [part] : []
        ),
        category: "input",
        code: issue.message === "A value is required." ? "required" : "type",
        source: "parameter",
        messageSource: "standard",
    }));
}
