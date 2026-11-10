import { decodeValue, encodeValue } from "./storage/values.js";

export type Key = string | number;
export type Scalar =
    | string
    | number
    | bigint
    | boolean
    | Date
    | null
    | undefined
    | { readonly [Symbol.toStringTag]: "Temporal.Instant" | "Temporal.PlainDate"; toString(): string };
/** Explicit reference; scalar literals never become field names based on position. */
export interface Field {
    readonly _tag: "Field";
    readonly path: readonly string[];
}
export type Operand = Field | Scalar;
export interface Row<A> {
    readonly key: Key;
    readonly value: A;
}
export interface Index {
    readonly name: string;
    readonly field: Field;
    readonly unique?: boolean;
    /** Index each scalar array element once per row. */
    readonly multiEntry?: boolean;
}
export type Predicate =
    | {
          readonly op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
          readonly left: Operand;
          readonly right: Operand;
      }
    | { readonly op: "in"; readonly left: Operand; readonly values: readonly Scalar[] }
    | { readonly op: "contains"; readonly left: Field; readonly right: Operand }
    | { readonly op: "like" | "ilike"; readonly left: Operand; readonly right: string | Field }
    | { readonly op: "and"; readonly predicates: readonly Predicate[] }
    | { readonly op: "or"; readonly predicates: readonly Predicate[] }
    | { readonly op: "not"; readonly predicate: Predicate };
export interface Order {
    readonly field: Field;
    readonly direction?: "asc" | "desc";
    /** Explicit nullish placement groups null and undefined as equal ordering values. */
    readonly nulls?: "first" | "last";
}
export interface Cursor {
    readonly values: readonly Scalar[];
    readonly key: Key;
}
export interface Query {
    readonly where?: Predicate;
    readonly orderBy?: readonly Order[];
    readonly limit?: number;
    readonly offset?: number;
    /** Exclusive keyset cursor in the query's complete sort order. */
    readonly after?: Cursor;
}
export interface ReadTable<A> {
    readonly name: string;
    /** Version this when the persisted representation or index meaning changes. */
    readonly version: number;
    readonly decode: (encoded: string) => A;
}
export interface Table<A> extends ReadTable<A> {
    readonly encode: (value: A) => string;
}
export interface ValueCodec<A> {
    readonly encode: (value: A) => unknown;
    readonly decode: (value: unknown) => A;
}
export const Table = {
    make<A>(options: {
        readonly name: string;
        readonly codec?: ValueCodec<A>;
        readonly version?: number;
    }): Table<A> {
        if (!options.name || !Number.isSafeInteger(options.version ?? 1) || (options.version ?? 1) < 1) {
            throw new Error("Tables require a nonempty name and a positive integer version.");
        }
        return {
            name: options.name,
            version: options.version ?? 1,
            encode: (value) => encodeValue(options.codec ? options.codec.encode(value) : value),
            decode: (encoded) =>
                options.codec ? options.codec.decode(decodeValue(encoded)) : (decodeValue(encoded) as A),
        };
    },
};
export { OntologyStorageError } from "./errors.js";
export type { OntologyStorageErrorReason } from "./errors.js";
export const field = (...path: string[]): Field => ({ _tag: "Field", path });
export const eq = (left: Operand, right: Operand): Predicate => ({ op: "eq", left, right });
export const ne = (left: Operand, right: Operand): Predicate => ({ op: "ne", left, right });
export const lt = (left: Operand, right: Operand): Predicate => ({ op: "lt", left, right });
export const lte = (left: Operand, right: Operand): Predicate => ({ op: "lte", left, right });
export const gt = (left: Operand, right: Operand): Predicate => ({ op: "gt", left, right });
export const gte = (left: Operand, right: Operand): Predicate => ({ op: "gte", left, right });
export const inArray = (left: Operand, values: readonly Scalar[]): Predicate => ({ op: "in", left, values });
export const contains = (array: Field, value: Operand): Predicate => ({
    op: "contains",
    left: array,
    right: value,
});
export const like = (left: Operand, right: string | Field): Predicate => ({ op: "like", left, right });
export const ilike = (left: Operand, right: string | Field): Predicate => ({ op: "ilike", left, right });
export const isNull = (operand: Operand): Predicate => eq(operand, null);
export const isUndefined = (operand: Operand): Predicate => eq(operand, undefined);
export const and = (...predicates: Predicate[]): Predicate => ({ op: "and", predicates });
export const or = (...predicates: Predicate[]): Predicate => ({ op: "or", predicates });
export const not = (predicate: Predicate): Predicate => ({ op: "not", predicate });
/** Optional namespace for callers who prefer it. */
export const where = {
    eq,
    ne,
    lt,
    lte,
    gt,
    gte,
    in: inArray,
    contains,
    like,
    ilike,
    isNull,
    isUndefined,
    and,
    or,
    not,
};
