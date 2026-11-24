import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { Redacted, Schema } from "effect";

/**
 * Foundry errors meaning a request referenced part of the ontology Foundry no longer has, or
 * used a property in a way it no longer allows: the definition this backend was built from is
 * probably stale. A type that is "not found" can also mean the caller lost access to it; a
 * replica that follows its definition checks the metadata again and keeps the error if the
 * definition did not change.
 */
const definitionErrors: ReadonlySet<string> = new Set([
    "ObjectTypeNotFound",
    "LinkTypeNotFound",
    "ActionTypeNotFound",
    "PropertiesNotFound",
    "ParametersNotFound",
    "ActionEditedPropertiesNotFound",
    "InvalidPropertyType",
    "PropertiesNotSearchable",
    "PropertiesNotSortable",
]);

const Failure = Schema.Struct({
    errorName: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
    reason: Schema.optional(Schema.Unknown),
});

const errorName = (cause: unknown) => {
    let candidate = cause;
    for (let depth = 0; depth < 5; depth++) {
        if (candidate instanceof BackendError) return undefined;
        const decoded = Schema.decodeUnknownOption(Failure)(candidate);
        if (decoded._tag === "None") return undefined;
        const name = decoded.value.errorName?.split(":").at(-1);
        if (name) return name;
        candidate = decoded.value.reason ?? decoded.value.cause;
    }
    return undefined;
};

/** `classifyBackendFailure` plus Foundry's errors about a changed ontology. */
export function classifyFoundryFailure(operation: string, cause: unknown): BackendError {
    if (cause instanceof BackendError) return cause;
    const name = errorName(cause);
    if (name !== undefined && definitionErrors.has(name))
        return new BackendError({
            operation,
            kind: "SchemaMismatch",
            retryable: false,
            message: "Foundry no longer recognizes part of this ontology definition.",
            cause: Redacted.make(cause),
        });
    // Ontology changes are being applied; Foundry asks callers to retry in a few seconds.
    if (name === "OntologySyncing")
        return new BackendError({
            operation,
            kind: "Unavailable",
            retryable: true,
            retryAfterMs: 5_000,
            message: "Foundry is applying ontology changes.",
            cause: Redacted.make(cause),
        });
    return classifyBackendFailure(operation, cause);
}
