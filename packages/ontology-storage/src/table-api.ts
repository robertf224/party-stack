export {
    Table,
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
export type {
    ReadTable,
    ValueCodec,
    Key,
    Scalar,
    Operand,
    Field,
    Row,
    Index,
    Predicate,
    Order,
    Cursor,
    Query,
} from "./model.js";
export { Tables } from "./tables.js";
export type { TablesService, Transaction, ReadTransaction, TableQuery, TableQueryOptions } from "./tables.js";
export { applyQuery, cursorOf, compareRows } from "./query/evaluate.js";

export {
    OntologyStorageError,
    OntologyStorageErrorReason,
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

export { isField } from "./query/schema.js";
