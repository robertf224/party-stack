import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { resolveType } from "@party-stack/ontology-spec/utils";
import { Schema } from "effect";
import type { OntologyIR, TypeDef } from "@party-stack/ontology-spec";

const Failure = Schema.Struct({
    errorName: Schema.optional(Schema.String),
    parameters: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    cause: Schema.optional(Schema.Unknown),
    reason: Schema.optional(Schema.Unknown),
});

/** Map only provider evidence about submitted references; a general 404 cannot identify a field. */
export function foundryActionError(
    operation: string,
    cause: unknown,
    ir: OntologyIR,
    actionName: string,
    values: Record<string, unknown>
): BackendError {
    if (cause instanceof BackendError) return cause;
    const normalized = classifyBackendFailure(operation, cause);
    const action = ir.actionTypes.find((action) => action.name === actionName);
    if (!action) return normalized;
    let candidate = cause;
    for (let depth = 0; depth < 5; depth++) {
        const decoded = Schema.decodeUnknownOption(Failure)(candidate);
        if (decoded._tag === "None") break;
        const error = decoded.value;
        const name = error.errorName?.split(":").at(-1);
        const paths: Array<readonly (string | number)[]> = [];
        if (name === "ActionParameterObjectNotFound") {
            const parameter = action.parameters.find(
                (parameter) => parameter.name === error.parameters?.parameterId
            );
            if (parameter) paths.push([parameter.name]);
        } else if (name === "ParameterObjectNotFound" || name === "ObjectNotFound") {
            const visit = (definition: TypeDef, value: unknown, path: readonly (string | number)[]) => {
                if (value === undefined || value === null) return;
                const type = resolveType(ir, definition);
                if (type.kind === "optional") visit(type.value.type, value, path);
                else if (type.kind === "list" && Array.isArray(value))
                    value.forEach((item, index) => visit(type.value.elementType, item, [...path, index]));
                else if (
                    type.kind === "objectReference" &&
                    type.value.objectType === error.parameters?.objectType &&
                    Object.is(value, error.parameters?.primaryKey)
                )
                    paths.push(path);
            };
            for (const parameter of action.parameters)
                visit(parameter.type, values[parameter.name], [parameter.name]);
        }
        if (paths.length)
            return new BackendError({
                operation,
                kind: "ValidationFailed",
                message: "Submission failed validation.",
                retryable: false,
                actionOutcome: "not-committed",
                cause: normalized.cause,
                issues: paths.map((path) => ({
                    path,
                    code: "InvalidObjectReference",
                    category: "reference",
                    source: "parameter",
                    messageSource: "standard",
                    message: "Choose a valid value.",
                })),
            });
        if (name) break;
        candidate = error.reason ?? error.cause;
    }
    return normalized;
}
