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
    length,
    operand,
    fieldExpression,
    rowBinding,
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
    Filter,
    Order,
    Cursor,
    Query,
} from "./model.js";
export { Tables } from "./tables.js";
export type {
    TablesService,
    Transaction,
    ReadTransaction,
    TableQuery,
    TableQueryOptions,
    TableKeysOptions,
} from "./tables.js";
export { applyQuery, cursorOf, compareRows } from "./query/evaluate.js";

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

export { isField } from "./query/schema.js";
export {
    fieldValues,
    filterField,
    filterOperand,
    inValues,
    isComparison,
    lengthComparison,
    lengthEmptiness,
    mapFilterFields,
    rebindFilter,
} from "./query/filter.js";
export type { FilterOperand, ComparisonKind } from "./query/filter.js";

export { tableUsage } from "./usage.js";
