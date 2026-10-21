import { Predicate, Schema } from "effect";

const ReasonFields = { message: Schema.String, cause: Schema.optional(Schema.Defect()) };
export class QueryError extends Schema.TaggedError<QueryError>()("QueryError", ReasonFields) {}
export class CodecError extends Schema.TaggedError<CodecError>()("CodecError", {
    ...ReasonFields,
    direction: Schema.Literals(["encode", "decode"]),
}) {}
export class UniqueConstraint extends Schema.TaggedError<UniqueConstraint>()("UniqueConstraint", {
    ...ReasonFields,
    table: Schema.String,
    index: Schema.String,
}) {}
export class SchemaMismatch extends Schema.TaggedError<SchemaMismatch>()("SchemaMismatch", {
    ...ReasonFields,
    table: Schema.String,
    expected: Schema.Int,
    actual: Schema.Int,
}) {}
export class DefinitionMismatch extends Schema.TaggedError<DefinitionMismatch>()("DefinitionMismatch", {
    ...ReasonFields,
    namespace: Schema.String,
    expected: Schema.String,
    actual: Schema.String,
}) {}
export class IndexError extends Schema.TaggedError<IndexError>()("IndexError", ReasonFields) {}
export class TransactionError extends Schema.TaggedError<TransactionError>()("TransactionError", {
    ...ReasonFields,
    kind: Schema.Literals(["Closed", "Nested", "ReadOnly", "Backend"]),
    retryable: Schema.Boolean,
}) {}
export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()(
    "ConfigurationError",
    ReasonFields
) {}
export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
    ...ReasonFields,
    backend: Schema.Literals(["indexeddb", "sql"]),
    retryable: Schema.Boolean,
}) {}

export const OntologyStorageErrorReason = Schema.Union([
    QueryError,
    CodecError,
    UniqueConstraint,
    SchemaMismatch,
    DefinitionMismatch,
    IndexError,
    TransactionError,
    ConfigurationError,
    StorageError,
]);
export type OntologyStorageErrorReason = typeof OntologyStorageErrorReason.Type;

/** A schema-backed boundary error with explicit, independently yieldable reasons. */
export class OntologyStorageError extends Schema.TaggedError<OntologyStorageError>()("OntologyStorageError", {
    operation: Schema.String,
    reason: OntologyStorageErrorReason,
}) {
    override readonly cause = this.reason;
    override get message(): string {
        return `Ontology storage ${this.operation} failed: ${this.reason.message}`;
    }
    get isRetryable(): boolean {
        return this.reason._tag === "StorageError"
            ? this.reason.retryable
            : this.reason._tag === "TransactionError" &&
                  this.reason.kind === "Backend" &&
                  this.reason.retryable;
    }
}

const causeMessage = (cause: unknown): string =>
    Predicate.isError(cause) ? cause.message : Predicate.isString(cause) ? cause : "See cause";
/** Internal constructors keep classification explicit at the failure boundary. */
export const queryError = (operation: string, cause: unknown) =>
    new OntologyStorageError({ operation, reason: new QueryError({ message: causeMessage(cause), cause }) });
export const codecError = (direction: "encode" | "decode", cause: unknown) =>
    new OntologyStorageError({
        operation: direction,
        reason: new CodecError({ direction, message: causeMessage(cause), cause }),
    });
export const indexError = (message: string, cause?: unknown) =>
    new OntologyStorageError({ operation: "index", reason: new IndexError({ message, cause }) });
export const transactionError = (
    kind: TransactionError["kind"],
    message: string,
    cause?: unknown,
    retryable = false
) =>
    new OntologyStorageError({
        operation: "transaction",
        reason: new TransactionError({ kind, message, cause, retryable }),
    });
export const storageError = (
    backend: StorageError["backend"],
    operation: string,
    cause: unknown,
    retryable = false
) =>
    new OntologyStorageError({
        operation,
        reason: new StorageError({ backend, message: causeMessage(cause), cause, retryable }),
    });
export const configurationError = (operation: string, message: string) =>
    new OntologyStorageError({ operation, reason: new ConfigurationError({ message }) });
