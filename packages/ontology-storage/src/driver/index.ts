import type { Index, Query, Table, OntologyStorageError } from "../model.js";
/** Backend implementor API. Versioned with the core package, not an application API. */
import type { Effect } from "effect";
export { makeTables } from "../tables.js";
// Encoding and native projection naming are part of the driver storage contract.
export { scalarKey, keyCode, caseInsensitiveIndex } from "../query/evaluate.js";
export interface StoredRow {
    readonly table: string;
    readonly key: string;
    readonly data: string;
    readonly indexValues?: Readonly<Record<string, string | readonly string[]>>;
}
export interface StoredIndex extends Index {
    readonly table: string;
    readonly version: number;
}
export interface Entry {
    readonly table: string;
    readonly index: string;
    readonly value: string;
    readonly key: string;
    readonly multiEntry?: boolean;
}
export interface Range {
    readonly direction?: "asc" | "desc";
    readonly lower?: string;
    readonly upper?: string;
    readonly lowerOpen?: boolean;
    readonly upperOpen?: boolean;
    readonly after?: { readonly value: string; readonly key: string };
    readonly limit?: number;
}
export interface DriverTransaction {
    /** Native indexes are maintained from StoredRow.indexValues rather than entry writes. */
    readonly nativeIndexes?: boolean;
    readonly clear: (table: string) => Effect.Effect<void, OntologyStorageError>;
    readonly get: (table: string, key: string) => Effect.Effect<StoredRow | undefined, OntologyStorageError>;
    readonly rows: (table: string) => Effect.Effect<readonly StoredRow[], OntologyStorageError>;
    readonly put: (row: StoredRow) => Effect.Effect<void, OntologyStorageError>;
    readonly delete: (table: string, key: string) => Effect.Effect<void, OntologyStorageError>;
    readonly indexes: (table: string) => Effect.Effect<readonly unknown[], OntologyStorageError>;
    readonly putIndex: (index: StoredIndex) => Effect.Effect<void, OntologyStorageError>;
    /** Return exact rows or a candidate superset requiring the shared residual evaluator. */
    readonly query: <A>(
        table: Table<A>,
        indexes: readonly StoredIndex[],
        query: Query
    ) => Effect.Effect<
        { readonly rows: readonly StoredRow[]; readonly complete: boolean },
        OntologyStorageError
    >;
    readonly countEntries: (
        table: string,
        index: string,
        range?: Range
    ) => Effect.Effect<number, OntologyStorageError>;
    readonly entries: (
        table: string,
        index: string,
        range?: Range
    ) => Effect.Effect<readonly Entry[], OntologyStorageError>;
    readonly putEntry: (entry: Entry) => Effect.Effect<void, OntologyStorageError>;
    readonly deleteEntries: (
        table: string,
        index: string,
        key?: string
    ) => Effect.Effect<void, OntologyStorageError>;
}
export interface Driver {
    readonly transaction: <A, E, R>(
        mode: "readonly" | "readwrite",
        body: (tx: DriverTransaction) => Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | OntologyStorageError, R>;
}

export {
    queryError,
    codecError,
    indexError,
    transactionError,
    storageError,
    configurationError,
} from "../errors.js";
