export { makeStorageModel } from "./ontology/model.js";
export type { StorageModel, ObjectStore, ObjectCodecs } from "./ontology/model.js";
export { OntologyStorage, makeOntologyStorage } from "./ontology/storage.js";
export type {
    StorageQuery,
    StorageQueryOptions,
    OntologyStorageService,
    StorageTransaction,
    ReadStorageTransaction,
} from "./ontology/storage.js";
export {
    field,
    where,
    eq,
    ne,
    lt,
    lte,
    gt,
    gte,
    inArray,
    contains,
    like,
    ilike,
    isNull,
    isUndefined,
    and,
    or,
    not,
} from "./model.js";
export type { Key, Scalar, Operand, Field, Index, Predicate, Order, Cursor, Query, Row } from "./model.js";
export { cursorOf } from "./query/evaluate.js";
export { QuerySchema } from "./query/codec.js";
export { indexesForQuery } from "./query/indexes.js";
export {
    OntologyStorageError,
    OntologyStorageErrorReason,
    BlobStorageError,
    QueryError,
    CodecError,
    UniqueConstraint,
    SchemaMismatch,
    DefinitionMismatch,
    IndexError,
    TransactionError,
    ConfigurationError,
    StorageError,
} from "./errors.js";
/** Pure evaluation of the portable query IR for composed/staged snapshots. */
export { applyQuery as evaluateQuery } from "./query/evaluate.js";

export { ontologyDefinitionSignature } from "./definition.js";

export { withObjectSources } from "./ontology/sources.js";
