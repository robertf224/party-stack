import { BackendError, projectBackendError } from "@party-stack/ontology-backend";
import { Effect, Layer } from "effect";
import { RpcMiddleware } from "effect/rpc";
import type { OntologyIR } from "@party-stack/ontology";
import type {
    ErrorProjection,
    ErrorProjectionContext,
    ValidationReport,
} from "@party-stack/ontology-backend";
import type { ReplicaStateSnapshot } from "@party-stack/ontology-backend/protocol";

export interface ErrorProjectionOptions {
    readonly errors?: ErrorProjection;
    /** The already projected schema, not the private authoritative definition. */
    readonly ir?: OntologyIR;
    readonly upstreamErrors?: boolean;
}
export const errorContext = (options: ErrorProjectionOptions, name?: string): ErrorProjectionContext => {
    const action = options.ir?.actionTypes.find((action) => action.name === name);
    return {
        upstream: options.upstreamErrors,
        parameters: action?.parameters.map((parameter) => parameter.name),
        objectReferenceParameters: action?.parameters
            .filter((parameter) => parameter.type.kind === "objectReference")
            .map((parameter) => parameter.name),
    };
};
export const projectValidationReport = (
    report: ValidationReport,
    options: ErrorProjectionOptions,
    name: string
): ValidationReport => {
    if (options.errors === "forward" || !report.certain || report.value.kind === "ok") return report;
    const error = projectBackendError(
        new BackendError({
            operation: "validate",
            kind: "ValidationFailed",
            message: "Submission failed validation.",
            issues: report.value.value,
            retryable: false,
        }),
        options.errors,
        errorContext(options, name)
    );
    return { certain: true, value: { kind: "err", value: error.issues ?? [{ message: error.message }] } };
};
export function projectStateFailures(
    state: ReplicaStateSnapshot,
    options: ErrorProjectionOptions
): ReplicaStateSnapshot {
    return {
        ...state,
        pending: state.pending.map((entry) => projectActionFailure(entry, options)),
        completed: state.completed.map((entry) => projectActionFailure(entry, options)),
    };
}
export const projectActionFailure = (
    entry: ReplicaStateSnapshot["pending"][number],
    options: ErrorProjectionOptions
) => {
    if (!entry.failure) return entry;
    const error = projectBackendError(
        new BackendError({
            operation: "applyAction",
            kind: entry.failure,
            message: entry.failureMessage ?? "Action failed.",
            issues: entry.failureIssues,
            retryable: entry.failureRetryable ?? false,
            actionOutcome: entry.failureOutcome,
        }),
        options.errors,
        errorContext(options, entry.invocation.name)
    );
    return { ...entry, failure: error.kind, failureMessage: error.message, failureIssues: error.issues };
};
export class OntologyErrorProjection extends RpcMiddleware.Service<OntologyErrorProjection>()(
    "@party-stack/ontology-server/ErrorProjection",
    { error: BackendError }
) {}
export const errorProjectionLayer = (options: ErrorProjectionOptions) =>
    Layer.succeed(OntologyErrorProjection, (effect, request) =>
        effect.pipe(
            Effect.mapError((error) => {
                if (!(error instanceof BackendError)) return error;
                const payload = request.payload as
                    | { name?: string; invocation?: { name?: string } }
                    | undefined;
                return projectBackendError(
                    error,
                    options.errors,
                    errorContext(options, payload?.name ?? payload?.invocation?.name)
                );
            }),
            Effect.catchDefect(() =>
                Effect.fail(
                    new BackendError({
                        operation: request.rpc._tag,
                        kind: "Internal",
                        message: "The operation could not be completed.",
                        retryable: false,
                        actionOutcome: "unknown",
                    })
                )
            )
        )
    );
